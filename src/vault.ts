import {
	createCipheriv,
	createDecipheriv,
	randomBytes,
	createHash,
} from "node:crypto";
import {
	readFileSync,
	writeFileSync,
	openSync,
	closeSync,
	fsyncSync,
	renameSync,
	rmSync,
	mkdirSync,
} from "node:fs";
import { dirname, join } from "node:path";
export class Vault {
	readonly key: Buffer;
	readonly id: string;
	constructor(key: Buffer) {
		if (key.length !== 32)
			throw Error("State encryption requires a 32-byte key");
		this.key = Buffer.from(key);
		this.id = createHash("sha256").update(key).digest("hex").slice(0, 16);
	}
	static file(path: string) {
		return new Vault(readFileSync(path));
	}
	seal(plain: Buffer | string, purpose: string) {
		const iv = randomBytes(12),
			cipher = createCipheriv("aes-256-gcm", this.key, iv);
		cipher.setAAD(Buffer.from("infraforge:v1:" + purpose));
		const data = Buffer.concat([cipher.update(plain), cipher.final()]);
		return JSON.stringify({
			v: 1,
			key: this.id,
			iv: iv.toString("base64"),
			tag: cipher.getAuthTag().toString("base64"),
			data: data.toString("base64"),
		});
	}
	open(envelope: string, purpose: string) {
		try {
			const e = JSON.parse(envelope);
			if (e.v !== 1 || e.key !== this.id) throw Error();
			const iv = Buffer.from(e.iv, "base64"),
				tag = Buffer.from(e.tag, "base64");
			if (iv.length !== 12 || tag.length !== 16) throw Error();
			const cipher = createDecipheriv("aes-256-gcm", this.key, iv);
			cipher.setAAD(Buffer.from("infraforge:v1:" + purpose));
			cipher.setAuthTag(tag);
			return Buffer.concat([
				cipher.update(Buffer.from(e.data, "base64")),
				cipher.final(),
			]);
		} catch {
			throw Error(
				"Encrypted data authentication failed (wrong key, context or damaged data)",
			);
		}
	}
	write(path: string, plain: Buffer | string, purpose: string) {
		mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
		const temp = join(
			dirname(path),
			".vault-" + randomBytes(12).toString("hex"),
		);
		try {
			writeFileSync(temp, this.seal(plain, purpose), {
				mode: 0o600,
				flag: "wx",
			});
			let fd = openSync(temp, "r");
			try {
				fsyncSync(fd);
			} finally {
				closeSync(fd);
			}
			renameSync(temp, path);
			fd = openSync(dirname(path), "r");
			try {
				fsyncSync(fd);
			} finally {
				closeSync(fd);
			}
		} finally {
			rmSync(temp, { force: true });
		}
	}
	read(path: string, purpose: string) {
		return this.open(readFileSync(path, "utf8"), purpose);
	}
}
