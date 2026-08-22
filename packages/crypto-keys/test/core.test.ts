import { createCipheriv, createHmac } from "node:crypto";

import { describe, expect, test } from "vitest";

import type { KeyProvider } from "@chatcap/config";

import {
  AesCbcEncryptor,
  EnvelopeError,
  HmacVerificationError,
  StaticKeyMaterialProvider,
  decodePayload,
  deriveKey,
  encodePayload,
  parsePayload,
  serializePayload,
  HKDF_INFO_AES,
  HKDF_INFO_HMAC,
  HMAC_LENGTH,
  IV_LENGTH,
  type Encryptor,
} from "../src/index";

/**
 * Fixed golden vectors (design §6.1). Computed with node:crypto hkdfSync:
 * master  = 0123456789abcdef... (32 bytes hex)
 * salt v1 = a1b2c3d4e5f60718293a4b5c6d7e8f90
 * salt v2 = 90f8e7d6c5b4a39281706f5e4d3c2b1a
 */
const MASTER = Buffer.from(
  "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef",
  "hex"
);
const SALT_1 = Buffer.from("a1b2c3d4e5f60718293a4b5c6d7e8f90", "hex");
const SALT_2 = Buffer.from("90f8e7d6c5b4a39281706f5e4d3c2b1a", "hex");

const AES_KEY_V1 = "74e3c1e78d91b32dadda14f404c9b762557715d06b566f9e5e3293e6e691cd9b";
const HMAC_KEY_V1 =
  "38a781e0669ce4bed2f6d0519f3e956101c67a123dda7f65050bde8227559e56";

const masterProvider: KeyProvider = {
  getMasterSecret: async () => MASTER,
};

function encryptorWithSalts(salts: ReadonlyMap<number, Buffer>): Encryptor {
  return new AesCbcEncryptor(
    masterProvider,
    new StaticKeyMaterialProvider(salts)
  );
}

const v1Only = encryptorWithSalts(new Map([[1, SALT_1]]));

describe("HKDF-SHA256 per-version derivation (REQ-KEY-1, design §6.1)", () => {
  test("derives the golden AES-256 key for the canonical master/salt/info", () => {
    const key = deriveKey(MASTER, SALT_1, HKDF_INFO_AES, 32);
    expect(key.toString("hex")).toBe(AES_KEY_V1);
  });

  test("derives the golden HMAC-SHA256 key for the canonical master/salt/info", () => {
    const key = deriveKey(MASTER, SALT_1, HKDF_INFO_HMAC, 32);
    expect(key.toString("hex")).toBe(HMAC_KEY_V1);
  });

  test("keeps AES and MAC keys in separate domains (different info strings)", () => {
    const aes = deriveKey(MASTER, SALT_1, HKDF_INFO_AES, 32);
    const mac = deriveKey(MASTER, SALT_1, HKDF_INFO_HMAC, 32);
    expect(aes.equals(mac)).toBe(false);
  });

  test("a different per-version salt derives a different key (forward secrecy)", () => {
    const v1 = deriveKey(MASTER, SALT_1, HKDF_INFO_AES, 32);
    const v2 = deriveKey(MASTER, SALT_2, HKDF_INFO_AES, 32);
    expect(v1.equals(v2)).toBe(false);
  });

  test("derivation is deterministic for identical inputs", () => {
    const a = deriveKey(MASTER, SALT_1, HKDF_INFO_AES, 32);
    const b = deriveKey(MASTER, SALT_1, HKDF_INFO_AES, 32);
    expect(a.equals(b)).toBe(true);
  });
});

describe("AES-256-CBC encrypt-then-MAC (design §6.1, REQ-CONSENT-3/4)", () => {
  test("round-trips plaintext through encrypt/decrypt with the canonical payload shape", async () => {
    const plaintext = Buffer.from("hola, ¿cómo te sientes hoy?", "utf8");
    const payload = await v1Only.encrypt(plaintext, 1);
    expect(payload.keyVersion).toBe(1);
    expect(payload.iv).toHaveLength(IV_LENGTH);
    expect(payload.hmac).toHaveLength(HMAC_LENGTH);
    expect(payload.ciphertext.equals(plaintext)).toBe(false);
    const decrypted = await v1Only.decrypt(payload);
    expect(decrypted.toString("utf8")).toBe("hola, ¿cómo te sientes hoy?");
  });

  test("produces unique ciphertexts for identical plaintexts (random IV)", async () => {
    const a = await v1Only.encrypt(Buffer.from("same"), 1);
    const b = await v1Only.encrypt(Buffer.from("same"), 1);
    expect(a.ciphertext.equals(b.ciphertext)).toBe(false);
  });

  test("round-trips an empty buffer (PKCS#7 padding boundary)", async () => {
    const payload = await v1Only.encrypt(Buffer.alloc(0), 1);
    const decrypted = await v1Only.decrypt(payload);
    expect(decrypted.length).toBe(0);
  });

  test("tampered ciphertext fails HMAC verification", async () => {
    const payload = await v1Only.encrypt(Buffer.from("secreto"), 1);
    const tampered = Buffer.from(payload.ciphertext);
    tampered[0] = (tampered[0] ?? 0) ^ 0xff;
    await expect(
      v1Only.decrypt({ ...payload, ciphertext: tampered })
    ).rejects.toBeInstanceOf(HmacVerificationError);
  });

  test("tampered IV fails HMAC verification (IV is MACed)", async () => {
    const payload = await v1Only.encrypt(Buffer.from("secreto"), 1);
    const tamperedIv = Buffer.from(payload.iv);
    tamperedIv[0] = (tamperedIv[0] ?? 0) ^ 0xff;
    await expect(
      v1Only.decrypt({ ...payload, iv: tamperedIv })
    ).rejects.toBeInstanceOf(HmacVerificationError);
  });

  test("tampered HMAC fails verification", async () => {
    const payload = await v1Only.encrypt(Buffer.from("secreto"), 1);
    const tamperedHmac = Buffer.from(payload.hmac);
    tamperedHmac[0] = (tamperedHmac[0] ?? 0) ^ 0xff;
    await expect(
      v1Only.decrypt({ ...payload, hmac: tamperedHmac })
    ).rejects.toBeInstanceOf(HmacVerificationError);
  });

  test("dual-read: rows encrypted under key N still decrypt while key N+1 is active (REQ-KEY-8)", async () => {
    const dual = encryptorWithSalts(
      new Map([
        [1, SALT_1],
        [2, SALT_2],
      ])
    );
    const oldRow = await dual.encrypt(Buffer.from("bajo la clave v1"), 1);
    const newRow = await dual.encrypt(Buffer.from("bajo la clave v2"), 2);
    // At most one active key for new writes: fresh writes target v2 (REQ-KEY-1).
    expect(newRow.keyVersion).toBe(2);
    // Old rows keep decrypting with their own key_version during transition.
    expect((await dual.decrypt(oldRow)).toString("utf8")).toBe("bajo la clave v1");
    expect((await dual.decrypt(newRow)).toString("utf8")).toBe("bajo la clave v2");
  });

  test("decryption fails loudly when the row key_version salt is unknown", async () => {
    const payload = await v1Only.encrypt(Buffer.from("x"), 1);
    const lostKey = encryptorWithSalts(new Map([[2, SALT_2]]));
    await expect(lostKey.decrypt(payload)).rejects.toThrow(
      /No salt known for key_version 1/
    );
  });
});

describe("payload codec: base64(iv || ciphertext || hmac) BYTEA (design §6.1)", () => {
  test("serialize -> parse restores the payload and still decrypts", async () => {
    const payload = await v1Only.encrypt(Buffer.from("envuelto"), 1);
    const serialized = serializePayload(payload);
    const parsed = parsePayload(1, serialized);
    expect(parsed).toEqual(payload);
    expect((await v1Only.decrypt(parsed)).toString("utf8")).toBe("envuelto");
  });

  test("the envelope is iv || ciphertext || hmac in that exact byte order", async () => {
    const payload = await v1Only.encrypt(Buffer.from("orden"), 1);
    const encoded = encodePayload(payload);
    expect(encoded.subarray(0, IV_LENGTH).equals(payload.iv)).toBe(true);
    expect(
      encoded
        .subarray(IV_LENGTH, encoded.length - HMAC_LENGTH)
        .equals(payload.ciphertext)
    ).toBe(true);
    expect(encoded.subarray(encoded.length - HMAC_LENGTH).equals(payload.hmac)).toBe(
      true
    );
  });

  test("decodePayload restores the components byte-for-byte", () => {
    const payload = {
      keyVersion: 1,
      iv: Buffer.from("0123456789abcdef"),
      ciphertext: Buffer.from("cifrado"),
      hmac: Buffer.from("h".repeat(HMAC_LENGTH)),
    };
    const decoded = decodePayload(1, encodePayload(payload));
    expect(decoded.iv.equals(payload.iv)).toBe(true);
    expect(decoded.ciphertext.equals(payload.ciphertext)).toBe(true);
    expect(decoded.hmac.equals(payload.hmac)).toBe(true);
  });

  test("the codec is transparent to tampering; HMAC owns integrity (decrypt catches it)", () => {
    const payload = {
      keyVersion: 1,
      iv: Buffer.from("0123456789abcdef"),
      ciphertext: Buffer.from("cifrado"),
      hmac: Buffer.from("h".repeat(HMAC_LENGTH)),
    };
    const encoded = encodePayload(payload);
    encoded[8] = (encoded[8] ?? 0) ^ 0xff;
    const parsed = decodePayload(1, encoded);
    expect(parsed.iv[8]).toBe(encoded[8]);
  });

  test("decodePayload rejects an envelope shorter than iv + hmac", () => {
    expect(() => decodePayload(1, Buffer.from("too-short"))).toThrow(EnvelopeError);
  });
});

describe("canonical envelope interoperability (design §6.1)", () => {
  test("decrypts a payload produced by raw node:crypto primitives with the same envelope", async () => {
    const aesKey = deriveKey(MASTER, SALT_1, HKDF_INFO_AES, 32);
    const macKey = deriveKey(MASTER, SALT_1, HKDF_INFO_HMAC, 32);
    const iv = Buffer.from("0123456789abcdef");
    const cipher = createCipheriv("aes-256-cbc", aesKey, iv);
    const ciphertext = Buffer.concat([
      cipher.update(Buffer.from("interoperable")),
      cipher.final(),
    ]);
    const hmac = createHmac("sha256", macKey).update(iv).update(ciphertext).digest();

    const decrypted = await v1Only.decrypt({
      keyVersion: 1,
      iv,
      ciphertext,
      hmac,
    });
    expect(decrypted.toString("utf8")).toBe("interoperable");
  });
});
