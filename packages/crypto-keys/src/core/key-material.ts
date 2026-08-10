/**
 * Per-version salt lookup (REQ-KEY-1/REQ-KEY-8). Decryption of a row uses the
 * salt of the row's OWN key_version — even when that version is already
 * expired — so dual-read keeps working during the rotation transition.
 * Production implementations read key_versions.salt from PostgreSQL;
 * StaticKeyMaterialProvider covers unit tests and small pilots.
 */
export interface KeyMaterialProvider {
  getSalt(keyVersion: number): Promise<Buffer>;
}

/** In-memory provider keyed by key_version (tests and small pilots). */
export class StaticKeyMaterialProvider implements KeyMaterialProvider {
  private readonly salts: ReadonlyMap<number, Buffer>;

  constructor(salts: ReadonlyMap<number, Buffer>) {
    this.salts = salts;
  }

  async getSalt(keyVersion: number): Promise<Buffer> {
    const salt = this.salts.get(keyVersion);
    if (salt === undefined) {
      throw new Error(`No salt known for key_version ${keyVersion}`);
    }
    return salt;
  }
}
