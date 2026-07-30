import { randomBytes, randomUUID } from "node:crypto";
import {
  chmod,
  link,
  lstat,
  mkdir,
  open,
  readFile,
  realpath,
  stat,
  unlink,
} from "node:fs/promises";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";

import { sha256 } from "./canonical.js";
import { UnlimitedTtsError } from "./errors.js";
import type { Artifact, SanitizedReceipt } from "./types.js";

const HANDLE_PATTERN = /^[a-f0-9]{32}$/;

async function publishWithoutOverwrite(
  temporary: string,
  destination: string,
): Promise<void> {
  try {
    await link(temporary, destination);
  } finally {
    await unlink(temporary).catch(() => undefined);
  }
}

export class ArtifactStore {
  #root: string;
  readonly #maximumBytes: number;
  #realRoot: string | null = null;
  readonly #audioPaths = new Map<string, string>();

  constructor(root: string, maximumBytes: number) {
    this.#root = resolve(root);
    this.#maximumBytes = maximumBytes;
  }

  get root(): string {
    return this.#root;
  }

  async initialize(): Promise<void> {
    await mkdir(this.#root, { recursive: true, mode: 0o700 });
    const info = await lstat(this.#root);
    if (!info.isDirectory() || info.isSymbolicLink()) {
      throw new UnlimitedTtsError(
        "CONFIGURATION_ERROR",
        "The output root must be a real directory, not a symlink.",
      );
    }
    this.#realRoot = await realpath(this.#root);
    // Canonicalize harmless parent aliases (for example /var -> /private/var
    // on macOS) while still rejecting a symlink at the configured root.
    this.#root = this.#realRoot;
    await chmod(this.#root, 0o700);
    await mkdir(join(this.#root, ".receipts"), {
      recursive: true,
      mode: 0o700,
    });
    const receiptsRoot = join(this.#root, ".receipts");
    const receiptsInfo = await lstat(receiptsRoot);
    if (
      !receiptsInfo.isDirectory() ||
      receiptsInfo.isSymbolicLink() ||
      (await realpath(receiptsRoot)) !== receiptsRoot
    ) {
      throw new UnlimitedTtsError(
        "CONFIGURATION_ERROR",
        "The receipt directory must be a real directory inside the output root.",
      );
    }
    await chmod(receiptsRoot, 0o700);
  }

  async writeAudio(bytes: Uint8Array): Promise<Artifact> {
    await this.#assertSafeRoot();
    if (bytes.byteLength > this.#maximumBytes) {
      throw new UnlimitedTtsError(
        "OUTPUT_TOO_LARGE",
        "The audio exceeds the configured local artifact size limit.",
        {
          details: {
            bytes: bytes.byteLength,
            maximumBytes: this.#maximumBytes,
          },
        },
      );
    }
    const id = randomBytes(16).toString("hex");
    const timestamp = new Date().toISOString().replaceAll(/[-:.TZ]/g, "");
    const filename = `tts_${timestamp}_${id}.mp3`;
    const destination = join(this.#root, filename);
    const temporary = join(this.#root, `.${filename}.${randomUUID()}.tmp`);
    const handle = await open(temporary, "wx", 0o600);
    try {
      await handle.writeFile(bytes);
      await handle.sync();
    } finally {
      await handle.close();
    }
    await publishWithoutOverwrite(temporary, destination);
    const info = await stat(destination);
    if (!info.isFile()) {
      throw new UnlimitedTtsError(
        "CONFIGURATION_ERROR",
        "The audio artifact was not written as a regular file.",
      );
    }
    this.#audioPaths.set(id, destination);
    return {
      id,
      uri: pathToFileURL(destination).href,
      resourceUri: `unlimitedtts://audio/${id}`,
      mimeType: "audio/mpeg",
      bytes: bytes.byteLength,
      sha256: sha256(bytes),
      expiresAt: null,
    };
  }

  async readAudio(artifactId: string): Promise<Uint8Array> {
    await this.#assertSafeRoot();
    if (!HANDLE_PATTERN.test(artifactId)) {
      throw new UnlimitedTtsError(
        "AUDIO_NOT_AVAILABLE",
        "The audio handle is invalid.",
      );
    }
    const path = this.#audioPaths.get(artifactId);
    if (!path) {
      throw new UnlimitedTtsError(
        "AUDIO_NOT_AVAILABLE",
        "The audio handle is not owned by this server session.",
      );
    }
    try {
      const info = await lstat(path);
      if (
        !info.isFile() ||
        info.isSymbolicLink() ||
        info.size > this.#maximumBytes
      ) {
        throw new Error("unsafe file");
      }
      return new Uint8Array(await readFile(path));
    } catch (cause) {
      throw new UnlimitedTtsError(
        "AUDIO_NOT_AVAILABLE",
        "The audio artifact is no longer available.",
        { cause },
      );
    }
  }

  async writeReceipt(receipt: SanitizedReceipt): Promise<void> {
    await this.#assertSafeRoot();
    if (!HANDLE_PATTERN.test(receipt.receiptId)) {
      throw new UnlimitedTtsError(
        "CONFIGURATION_ERROR",
        "The receipt handle is invalid.",
      );
    }
    const path = join(this.#root, ".receipts", `${receipt.receiptId}.json`);
    const temporary = `${path}.${randomUUID()}.tmp`;
    const handle = await open(temporary, "wx", 0o600);
    try {
      await handle.writeFile(`${JSON.stringify(receipt)}\n`, "utf8");
      await handle.sync();
    } finally {
      await handle.close();
    }
    await publishWithoutOverwrite(temporary, path);
  }

  async readReceipt(receiptId: string): Promise<SanitizedReceipt> {
    await this.#assertSafeRoot();
    if (!HANDLE_PATTERN.test(receiptId)) {
      throw new UnlimitedTtsError(
        "AUDIO_NOT_AVAILABLE",
        "The receipt handle is invalid.",
      );
    }
    try {
      const path = join(this.#root, ".receipts", `${receiptId}.json`);
      const info = await lstat(path);
      if (!info.isFile() || info.isSymbolicLink() || info.size > 1_048_576) {
        throw new Error("unsafe receipt");
      }
      return JSON.parse(
        await readFile(path, "utf8"),
      ) as SanitizedReceipt;
    } catch (cause) {
      throw new UnlimitedTtsError(
        "AUDIO_NOT_AVAILABLE",
        "The receipt is not available.",
        { cause },
      );
    }
  }

  async #assertSafeRoot(): Promise<void> {
    if (this.#realRoot === null) await this.initialize();
    const current = await realpath(this.#root);
    if (current !== this.#realRoot) {
      throw new UnlimitedTtsError(
        "CONFIGURATION_ERROR",
        "The output root changed after initialization.",
      );
    }
  }
}
