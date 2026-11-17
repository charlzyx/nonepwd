import { describe, expect, open, test } from "nsh/test";
import {
  AAD,
  auditVaultItems,
  buildOtpAuthUri,
  decryptJson,
  deriveAccountKeys,
  encryptBytes,
  encryptJson,
  fromBase64Url,
  generateEmailKeyPair,
  generatePassword,
  generateRawAesKey,
  generateSecretKey,
  generateTotp,
  normalizeSecretKey,
  openSealedJson,
  parseAuthenticatorExport,
  planTotpImport,
  sealJsonForPublicKey,
  toBase32,
  toBase64Url,
  utf8Encode,
  type DecryptedEmailPayload,
  type ImapAccountPublic,
  type RootKeysetPayload,
  type SealedEnvelope,
  type VaultItemPayload,
} from "./src/crypto";
import { decodeQrFromRgba } from "./src/qr-cpu";

// ---------- Minimal ISO/IEC 18004 Version-1-L QR Renderer for RGBA Unit Tests ----------

function encodeVersion1QrRgba(
  text: string,
  opts: { scale?: number; quiet?: number; invert?: boolean; corruptByteModuleIdx?: number[] } = {}
): { rgba: Uint8Array; width: number; height: number } {
  const scale = opts.scale ?? 4;
  const quiet = opts.quiet ?? 4;
  const size = 21;
  const payload = new TextEncoder().encode(text);
  if (payload.length > 17) throw new Error("Version 1-L byte mode max 17 bytes");

  // 1. Build 19 data bytes
  const bits: number[] = [];
  const pushBits = (val: number, count: number) => {
    for (let i = count - 1; i >= 0; i--) bits.push((val >> i) & 1);
  };
  pushBits(0b0100, 4); // Byte mode
  pushBits(payload.length, 8);
  for (const b of payload) pushBits(b, 8);
  pushBits(0, Math.min(4, 152 - bits.length));
  while (bits.length % 8 !== 0) bits.push(0);
  let padByte = 0xec;
  while (bits.length < 152) {
    pushBits(padByte, 8);
    padByte = padByte === 0xec ? 0x11 : 0xec;
  }

  const data = new Uint8Array(19);
  for (let i = 0; i < 19; i++) {
    let v = 0;
    for (let b = 0; b < 8; b++) v = (v << 1) | bits[i * 8 + b];
    data[i] = v;
  }

  // 2. GF(256) Reed-Solomon 7 EC bytes (poly 0x11d)
  const exp = new Uint8Array(512);
  const log = new Uint8Array(256);
  let x = 1;
  for (let i = 0; i < 255; i++) {
    exp[i] = x;
    log[x] = i;
    x <<= 1;
    if (x & 0x100) x ^= 0x11d;
  }
  for (let i = 255; i < 512; i++) exp[i] = exp[i - 255];
  const gfMul = (a: number, b: number) => (a === 0 || b === 0 ? 0 : exp[log[a] + log[b]]);

  // Generator poly for 7 roots: prod_{i=0..6} (x - alpha^i)
  let gen = [1];
  for (let i = 0; i < 7; i++) {
    const next = new Array<number>(gen.length + 1).fill(0);
    for (let j = 0; j < gen.length; j++) {
      next[j] ^= gen[j];
      next[j + 1] ^= gfMul(gen[j], exp[i]);
    }
    gen = next;
  }

  const rem = new Uint8Array(26);
  rem.set(data, 0);
  for (let i = 0; i < 19; i++) {
    const coef = rem[i];
    if (coef !== 0) {
      for (let j = 0; j < gen.length; j++) {
        rem[i + j] ^= gfMul(gen[j], coef);
      }
    }
  }
  const codewords = new Uint8Array(26);
  codewords.set(data, 0);
  codewords.set(rem.subarray(19), 19);

  // 3. Matrix & Function patterns
  const modules: boolean[][] = Array.from({ length: size }, () => new Array(size).fill(false));
  const isFunc: boolean[][] = Array.from({ length: size }, () => new Array(size).fill(false));

  const setMod = (r: number, c: number, dark: boolean, func = true) => {
    if (r < 0 || r >= size || c < 0 || c >= size) return;
    modules[r][c] = dark;
    if (func) isFunc[r][c] = true;
  };

  const drawFinder = (r0: number, c0: number) => {
    for (let dr = -1; dr <= 7; dr++) {
      for (let dc = -1; dc <= 7; dc++) {
        const inBox = dr >= 0 && dr <= 6 && dc >= 0 && dc <= 6;
        const dark =
          inBox &&
          (dr === 0 ||
            dr === 6 ||
            dc === 0 ||
            dc === 6 ||
            (dr >= 2 && dr <= 4 && dc >= 2 && dc <= 4));
        setMod(r0 + dr, c0 + dc, dark, true);
      }
    }
  };
  drawFinder(0, 0);
  drawFinder(0, size - 7);
  drawFinder(size - 7, 0);

  for (let i = 8; i < size - 8; i++) {
    setMod(6, i, i % 2 === 0, true);
    setMod(i, 6, i % 2 === 0, true);
  }
  setMod(size - 8, 8, true, true); // Dark module

  // Reserve format info cells
  for (let i = 0; i <= 8; i++) {
    isFunc[8][i] = true;
    isFunc[i][8] = true;
  }
  for (let i = size - 8; i < size; i++) isFunc[8][i] = true;
  for (let i = size - 7; i < size; i++) isFunc[i][8] = true;

  // Format info: EC=L (01), Mask=0 (000) -> data = 8
  const fmtData = (0b01 << 3) | 0;
  let bch = fmtData << 10;
  for (let b = 14; b >= 10; b--) {
    if ((bch & (1 << b)) !== 0) bch ^= 0x537 << (b - 10);
  }
  const fmtWord = ((fmtData << 10) | bch) ^ 0x5412;
  const fmtBit = (idx: number) => ((fmtWord >> (14 - idx)) & 1) === 1;
  for (let c = 0; c <= 5; c++) modules[8][c] = fmtBit(c);
  modules[8][7] = fmtBit(6);
  modules[8][8] = fmtBit(7);
  modules[7][8] = fmtBit(8);
  for (let i = 0; i < 6; i++) modules[5 - i][8] = fmtBit(9 + i);
  for (let i = 0; i < 7; i++) modules[size - 1 - i][8] = fmtBit(i);
  for (let i = 0; i < 8; i++) modules[8][size - 8 + i] = fmtBit(7 + i);

  // Place data bits in zigzag with mask 0 ((r + c) % 2 === 0)
  const allBits: number[] = [];
  for (const cw of codewords) {
    for (let b = 7; b >= 0; b--) allBits.push((cw >> b) & 1);
  }
  let bitIdx = 0;
  let right = size - 1;
  let upward = true;
  while (right >= 1) {
    if (right === 6) right -= 1;
    for (let i = 0; i < size; i++) {
      const r = upward ? size - 1 - i : i;
      for (let dx = 0; dx <= 1; dx++) {
        const c = right - dx;
        if (isFunc[r][c]) continue;
        const bit = bitIdx < allBits.length ? allBits[bitIdx++] === 1 : false;
        modules[r][c] = (r + c) % 2 === 0 ? !bit : bit;
      }
    }
    upward = !upward;
    right -= 2;
  }

  // Optional synthetic noise inside data region to test Reed-Solomon recovery
  for (const modIdx of opts.corruptByteModuleIdx ?? []) {
    const r = size - 1 - Math.floor(modIdx / 2);
    const c = size - 1 - (modIdx % 2);
    if (!isFunc[r]?.[c]) modules[r][c] = !modules[r][c];
  }

  // 4. Render to RGBA
  const full = size + quiet * 2;
  const w = full * scale;
  const h = full * scale;
  const rgba = new Uint8Array(w * h * 4);
  for (let py = 0; py < h; py++) {
    const mr = Math.floor(py / scale) - quiet;
    for (let px = 0; px < w; px++) {
      const mc = Math.floor(px / scale) - quiet;
      const inQr = mr >= 0 && mr < size && mc >= 0 && mc < size;
      let dark = inQr ? modules[mr][mc] : false;
      if (opts.invert) dark = !dark;
      const val = dark ? 12 : 248;
      const off = (py * w + px) * 4;
      rgba[off] = val;
      rgba[off + 1] = val;
      rgba[off + 2] = val;
      rgba[off + 3] = 255;
    }
  }
  return { rgba, width: w, height: h };
}

// ---------- Protobuf Builder Helper for Migration Tests ----------

function pbVarint(v: number, out: number[]) {
  let n = v >>> 0;
  while (true) {
    let b = n & 0x7f;
    n >>>= 7;
    if (n !== 0) b |= 0x80;
    out.push(b);
    if (n === 0) break;
  }
}

function pbLenField(fieldNum: number, bytes: Uint8Array, out: number[]) {
  pbVarint((fieldNum << 3) | 2, out);
  pbVarint(bytes.length, out);
  for (const b of bytes) out.push(b);
}

function pbVarintField(fieldNum: number, val: number, out: number[]) {
  pbVarint((fieldNum << 3) | 0, out);
  pbVarint(val, out);
}

// ---------- Tests ----------

describe("NonePwd Crypto & Core Interop", () => {
  test("matches exact @nonepwd/core Rust WASM interop vectors (PBKDF2+HKDF, AES-GCM AAD, X25519 SealedEnvelope)", async () => {
    const sk = "NP3-ABCDEF-GHJKLM-NPQRST-UVWXYZ-234567";
    const salt = "MDEyMzQ1Njc4OWFiY2RlZg";
    const derived = await deriveAccountKeys("Master#2026!", sk, salt, 10_000);
    expect(derived.masterUnlockKeyB64).toBe("EtkpJkfbUBg1eNty8l8LciBQ3SlfO8mT0hjmL0pjAsY");
    expect(derived.authVerifierB64).toBe("j4Qni3QQMGReYSbz4HD_fHLltiEC4qUqcRV-nxg_6TI");

    // Case/space/hyphen normalization produces identical keys
    const normalized = await deriveAccountKeys(
      "Master#2026!",
      sk.toLowerCase().replace(/-/g, " "),
      salt,
      10_000
    );
    expect(normalized.masterUnlockKeyB64).toBe(derived.masterUnlockKeyB64);
    expect(normalized.authVerifierB64).toBe(derived.authVerifierB64);

    // Decrypt blob encrypted by @nonepwd/core WASM with AAD binding
    const wasmBlob =
      "v1.QahJdmpjTm87N0li.VKz2s2P-HMyxwm2ajWeLYm0JySAjeUroLu9v237sXJEZlqYlO0Te_a9mLwpxUhJOCAm9msx6T72P9cPK5R1nhixtrrhcSkAUu8MySf5yhGMzvvKqJmc-uQ15_5WzfHU8T7WDE40RcX4x5x_736RCg2QRCyWiXDdh1Yztxo1iRfhvQXa20a2ayYdnLf5Zrrg1zyk4YfdaoXwr1RGCvuOfEy3r2kAokT_Uu0PQec2oEljB6PhTgiFzKBB0UInZ7_RIsYa4r7hx2dts6ld4f1mlCYjeFTx_EjacQxnBbig7hl7zJ6rfNsOh8rE838ZG_PtzbiAMa5V1egj38gjwXIoFJpdi50AGcmb1GFbz526_ZeCKAv98CymRQRYGZSQdDutyjxriSW_x4Ubdq7jwT6Utg5AiJkEQnGhRuo-T";
    const decrypted = await decryptJson<VaultItemPayload>(
      derived.masterUnlockKeyBytes,
      wasmBlob,
      AAD.vaultItem("vault-vec-1", "item-vec-1")
    );
    expect(decrypted.title).toBe("GitHub");
    expect(decrypted.username).toBe("octocat");
    expect(decrypted.password).toBe("pw-vector");
    expect(decrypted.totp).toBe("JBSWY3DPEHPK3PXP");

    // Tampered AAD must reject
    await expect(
      decryptJson(
        derived.masterUnlockKeyBytes,
        wasmBlob,
        AAD.vaultItem("vault-vec-2", "item-vec-1")
      )
    ).rejects.toThrow();

    // Open X25519 SealedEnvelope sealed by @nonepwd/core WASM
    const wasmPriv = "MC4CAQAwBQYDK2VuBCIEIHWgp24HWSBVyuB4RLoPEgI-a44GZZgWibgTsIH2jJsr";
    const wasmSealed: SealedEnvelope = {
      v: 1,
      epk: "2hamwjycVxDSwxp_bJBX8Bz3y6mxBGQ4b6eN_RtO_jQ",
      iv: "NZTUi45gf0NZusPC",
      ct: "wef-0GTlfVRobdnDLsMo1qO4T38iL-yxG44L5e44RAicFj7TyHlzWBaogsglkOp3YXSTHDGOfPaFIvl4m8au67YcaCVhIuJ5EpnJP6YJeCNOa4Z8as9yGPSp54zXpgMTz1v7B7Wyt_rHi0LAW7vxLsiqMdcPqSCDzfyf51ntiB0ZMzuoak_t2Zt9370b0c7KpZ_AGqeNSzRkFWp3jzIVXcZHpfmhB4HaUupk1YlY4rfsKNX_NBZoZRdZq9P1K7mQxpDUe3TOWponPr7goitquZavkWq16YETILS6HBFCjj6z7frqKY9sYPkx9A_3YGqzLUOaL4VCumNGRvOUg3FB-3DVokJ0tu0",
    };
    const opened = await openSealedJson<DecryptedEmailPayload>(
      wasmPriv,
      wasmSealed,
      "nonepwd-email-v1"
    );
    expect(opened.from).toBe("GitHub <noreply@github.com>");
    expect(opened.otpCode).toBe("839204");
    expect(opened.senderDomain).toBe("github.com");

    // Local X25519 keygen + seal + open roundtrip
    const kp = await generateEmailKeyPair();
    const env2 = await sealJsonForPublicKey(kp.publicKeyB64, { code: "112233" });
    const dec2 = await openSealedJson<{ code: string }>(kp.privateKeyPkcs8B64, env2);
    expect(dec2.code).toBe("112233");

    // Secret key generation format
    const newSk = generateSecretKey();
    expect(newSk).toMatch(/^NP3(-[23456789ABCDEFGHJKLMNPQRSTUVWXYZ]{6}){5}$/);
    expect(normalizeSecretKey(newSk.toLowerCase())).toBe(newSk.replace(/-/g, ""));
  });

  test("generates RFC 6238 TOTP codes, parses otpauth & Google migration protobuf, and plans import", async () => {
    const secretB32 = toBase32(utf8Encode("12345678901234567890"));
    const uri8 = buildOtpAuthUri({
      secret: secretB32,
      issuer: "RFC",
      account: "test",
      digits: 8,
      period: 30,
      algorithm: "SHA1",
    });
    const res8 = await generateTotp(uri8, 59_000);
    expect(res8.code).toBe("94287082");

    const res6 = await generateTotp(secretB32, 59_000);
    expect(res6.code).toBe("287082");
    expect(res6.remainingSeconds).toBe(1);

    // Multi-line otpauth + comment + HOTP skip
    const lines = [
      "# comment",
      "otpauth://totp/GitHub:octocat@github.com?secret=JBSWY3DPEHPK3PXP&issuer=GitHub",
      "otpauth://hotp/Legacy:old?secret=JBSWY3DPEHPK3PXP&counter=1",
      "otpauth://totp/Cloudflare:ops%40example.com?secret=GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQ&issuer=Cloudflare&digits=8&period=60&algorithm=SHA256",
    ].join("\n");
    const parsedLines = parseAuthenticatorExport(lines);
    expect(parsedLines).toHaveLength(2);
    expect(parsedLines[0].issuer).toBe("GitHub");
    expect(parsedLines[1].digits).toBe(8);
    expect(parsedLines[1].period).toBe(60);
    expect(parsedLines[1].algorithm).toBe("SHA256");

    // Google Authenticator otpauth-migration:// protobuf payload
    const entry1: number[] = [];
    pbLenField(1, utf8Encode("12345678901234567890"), entry1);
    pbLenField(2, utf8Encode("Google:alice@gmail.com"), entry1);
    pbLenField(3, utf8Encode("Google"), entry1);
    pbVarintField(4, 1, entry1); // SHA1
    pbVarintField(5, 1, entry1); // 6 digits
    pbVarintField(6, 2, entry1); // TOTP

    const entryHotp: number[] = [];
    pbLenField(1, utf8Encode("hotpsecret"), entryHotp);
    pbLenField(2, utf8Encode("SkipMe"), entryHotp);
    pbVarintField(6, 1, entryHotp); // HOTP skipped

    const entry3: number[] = [];
    pbLenField(1, new Uint8Array([0xfb, 0xff, 0xbf, 0x11, 0x22, 0x33, 0x44, 0x55, 0x66, 0x77]), entry3);
    pbLenField(2, utf8Encode("dev@stripe.com"), entry3);
    pbLenField(3, utf8Encode("Stripe"), entry3);
    pbVarintField(4, 2, entry3); // SHA256
    pbVarintField(5, 2, entry3); // 8 digits
    pbVarintField(6, 2, entry3); // TOTP

    const migration: number[] = [];
    pbLenField(1, new Uint8Array(entry1), migration);
    pbLenField(1, new Uint8Array(entryHotp), migration);
    pbLenField(1, new Uint8Array(entry3), migration);
    pbVarintField(2, 1, migration);

    const stdB64 = Buffer.from(migration).toString("base64");
    const urlEncoded = stdB64
      .replace(/\+/g, "%2B")
      .replace(/\//g, "%2F")
      .replace(/=/g, "%3D");
    const migEntries = parseAuthenticatorExport(`otpauth-migration://offline?data=${urlEncoded}`);
    expect(migEntries).toHaveLength(2);
    expect(migEntries[0].issuer).toBe("Google");
    expect(migEntries[0].account).toBe("alice@gmail.com");
    expect((await generateTotp(migEntries[0].otpauthUri, 59_000)).code).toBe("287082");
    expect(migEntries[1].issuer).toBe("Stripe");
    expect(migEntries[1].digits).toBe(8);
    expect(migEntries[1].algorithm).toBe("SHA256");

    // Import planner: duplicate skip, attach, create
    const existing: VaultItemPayload[] = [
      {
        id: "item-google",
        vaultId: "v1",
        category: "login",
        title: "google.com",
        favorite: false,
        tags: [],
        urls: ["https://accounts.google.com/v3/signin"],
        username: "alice@gmail.com",
        password: "pw",
        customFields: [],
        createdAt: "",
        updatedAt: "",
      },
      {
        id: "item-dup",
        vaultId: "v1",
        category: "login",
        title: "GitHub",
        favorite: false,
        tags: [],
        urls: ["https://github.com"],
        username: "octocat@github.com",
        password: "pw",
        totp: "JBSWY3DPEHPK3PXP",
        customFields: [],
        createdAt: "",
        updatedAt: "",
      },
    ];
    const plan = planTotpImport(existing, [parsedLines[0], ...migEntries]);
    expect(plan).toHaveLength(3);
    expect(plan[0].action).toBe("skip_duplicate");
    expect(plan[1]).toMatchObject({ action: "attach", itemId: "item-google" });
    expect(plan[2]).toMatchObject({
      action: "create",
      title: "Stripe",
      username: "dev@stripe.com",
    });

    // Password generator & Security audit
    const pw = generatePassword({ length: 24, symbols: true });
    expect(pw).toHaveLength(24);
    const audit = auditVaultItems([
      { ...existing[0], password: "123" },
      { ...existing[1], password: "reused-strong-password-123" },
      { ...existing[0], id: "item-reused-2", password: "reused-strong-password-123", totp: undefined },
    ]);
    expect(audit.weakItems).toHaveLength(1);
    expect(audit.reusedItems).toHaveLength(2);
    expect(audit.missingTotpItems).toHaveLength(2);
  });
});

describe("Pure-TS QR Decoder", () => {
  test("decodes Version-1 QR code from RGBA buffer including inverted & RS error recovery", () => {
    const payload = "otpauth://totp/x";
    const clean = encodeVersion1QrRgba(payload);
    expect(decodeQrFromRgba(clean.rgba, clean.width, clean.height)).toEqual([payload]);

    const inverted = encodeVersion1QrRgba(payload, { invert: true });
    expect(decodeQrFromRgba(inverted.rgba, inverted.width, inverted.height)).toEqual([payload]);

    // Corrupt 2 distinct codeword bits to verify GF(256) Reed-Solomon recovery
    const noisy = encodeVersion1QrRgba(payload, { corruptByteModuleIdx: [2, 18] });
    expect(decodeQrFromRgba(noisy.rgba, noisy.width, noisy.height)).toEqual([payload]);
  });
});

async function buildTestVaultFixture() {
  const sk = generateSecretKey();
  const masterPassword = "VaultMaster#2026";
  const kdfSalt = toBase64Url(utf8Encode("0123456789abcdef"));
  const kdfIterations = 10_000;
  const { masterUnlockKeyBytes, authVerifierB64 } = await deriveAccountKeys(
    masterPassword,
    sk,
    kdfSalt,
    kdfIterations
  );

  const rootKeyBytes = generateRawAesKey();
  const emailKp = await generateEmailKeyPair();
  const keyset: RootKeysetPayload = {
    rootKeyB64: toBase64Url(rootKeyBytes),
    emailPrivateKeyPkcs8B64: emailKp.privateKeyPkcs8B64,
  };
  const encryptedRootKeyset = await encryptJson(
    masterUnlockKeyBytes,
    keyset,
    AAD.ROOT_KEYSET
  );

  const vaultId = "vault-personal";
  const vaultKey = generateRawAesKey();
  const encryptedVaultKey = await encryptBytes(
    rootKeyBytes,
    vaultKey,
    AAD.vaultOwnerKey(vaultId)
  );
  const encryptedVaultMeta = await encryptJson(
    vaultKey,
    { name: "Personal", description: "个人库" },
    AAD.vaultMeta(vaultId)
  );

  const githubItem: VaultItemPayload = {
    id: "item-gh",
    vaultId,
    category: "login",
    title: "GitHub",
    favorite: true,
    tags: ["dev"],
    urls: ["https://github.com"],
    username: "alice@github.com",
    password: "strong-unique-password-99",
    totp: "GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQ",
    customFields: [],
    createdAt: "2026-01-01T00:00:00Z",
    updatedAt: "2026-01-01T00:00:00Z",
  };
  const weakItem: VaultItemPayload = {
    id: "item-weak",
    vaultId,
    category: "login",
    title: "LegacyForum",
    favorite: false,
    tags: [],
    urls: ["https://forum.example.com"],
    username: "bob",
    password: "short",
    customFields: [],
    createdAt: "2026-01-01T00:00:00Z",
    updatedAt: "2026-01-01T00:00:00Z",
  };

  const encryptedItems = [
    {
      id: githubItem.id,
      vaultId,
      encryptedData: await encryptJson(vaultKey, githubItem, AAD.vaultItem(vaultId, githubItem.id)),
      createdAt: "2026-01-01T00:00:00Z",
      updatedAt: "2026-01-01T00:00:00Z",
      version: 1,
    },
    {
      id: weakItem.id,
      vaultId,
      encryptedData: await encryptJson(vaultKey, weakItem, AAD.vaultItem(vaultId, weakItem.id)),
      createdAt: "2026-01-01T00:00:00Z",
      updatedAt: "2026-01-01T00:00:00Z",
      version: 1,
    },
  ];

  const sealedEmail = await sealJsonForPublicKey(emailKp.publicKeyB64, {
    from: "GitHub <noreply@github.com>",
    to: "work@gmail.com",
    subject: "[GitHub] Device Verification",
    snippet: "Your verification code is 839204",
    textBody: "Your verification code is 839204. Valid for 10 minutes.",
    otpCode: "839204",
    confidence: 0.96,
    magicLink: "https://github.com/login/verify?t=1",
    senderDomain: "github.com",
    receivedAt: "2026-01-01T00:00:00Z",
  });

  const imapAccounts: ImapAccountPublic[] = [
    {
      id: "imap-1",
      label: "工作 Gmail",
      enabled: true,
      host: "imap.gmail.com",
      port: 993,
      tls: true,
      username: "work@gmail.com",
      hasPassword: true,
      status: "listening",
      lastError: null,
      lastSyncAt: "2026-01-01T00:00:00Z",
    },
    {
      id: "imap-2",
      label: "个人 Gmail",
      enabled: true,
      host: "imap.gmail.com",
      port: 993,
      tls: true,
      username: "personal@gmail.com",
      hasPassword: true,
      status: "listening",
      lastError: null,
      lastSyncAt: "2026-01-01T00:00:00Z",
    },
  ];

  let filterConfig = { enabled: false, otpOnly: false, mode: "allow", rules: [] };

  const networkRoutes = {
    "GET http://127.0.0.1:8787/api/auth/params": {
      body: { initialized: true, kdfSalt, kdfIterations },
    },
    "POST http://127.0.0.1:8787/api/auth/login": async (req: { body?: string | null }) => {
      const parsed = JSON.parse(req.body ?? "{}") as { authVerifier?: string };
      if (parsed.authVerifier !== authVerifierB64) {
        return { status: 401, body: { error: "Invalid credentials" } };
      }
      return {
        body: {
          token: "tok_test_1",
          account: {
            email: "owner@example.com",
            encryptedRootKeyset,
          },
        },
      };
    },
    "GET http://127.0.0.1:8787/api/sync": () => ({
      body: {
        kind: "owner",
        account: {
          email: "owner@example.com",
          emailPublicKey: emailKp.publicKeyB64,
          cfWebhookSecret: "whsec",
          aliasDomain: "mail.example.com",
        },
        vaults: [
          {
            id: vaultId,
            encryptedKey: encryptedVaultKey,
            encryptedMeta: encryptedVaultMeta,
            createdAt: "2026-01-01T00:00:00Z",
            updatedAt: "2026-01-01T00:00:00Z",
          },
        ],
        items: encryptedItems,
        aliases: [],
        emails: [
          {
            id: "em-1",
            source: "imap",
            envelopeTo: "work@gmail.com",
            hasOtp: true,
            sealedEnvelope: sealedEmail,
            receivedAt: "2026-01-01T00:00:00Z",
          },
        ],
        imapAccounts,
        emailFilter: filterConfig,
      },
    }),
    [`POST http://127.0.0.1:8787/api/vaults/${vaultId}/items`]: (req: {
      body?: string | null;
    }) => {
      const body = JSON.parse(req.body ?? "{}") as { id: string; encryptedData: string };
      const rec = {
        id: body.id,
        vaultId,
        encryptedData: body.encryptedData,
        createdAt: "2026-01-01T00:00:00Z",
        updatedAt: "2026-01-01T00:00:00Z",
        version: 1,
      };
      encryptedItems.unshift(rec);
      return { status: 201, body: { item: rec } };
    },
    "POST http://127.0.0.1:8787/api/imap/accounts": (req: { body?: string | null }) => {
      const body = JSON.parse(req.body ?? "{}") as {
        label?: string;
        enabled?: boolean;
        host: string;
        port: number;
        tls: boolean;
        username: string;
      };
      const created: ImapAccountPublic = {
        id: `imap-${imapAccounts.length + 1}`,
        label: body.label || body.username,
        enabled: body.enabled ?? true,
        host: body.host,
        port: body.port,
        tls: body.tls,
        username: body.username,
        hasPassword: true,
        status: "listening",
        lastError: null,
        lastSyncAt: null,
      };
      imapAccounts.push(created);
      return { status: 201, body: { account: created, accounts: imapAccounts } };
    },
    "GET http://127.0.0.1:8787/api/email-filter": () => ({ body: filterConfig }),
    "PUT http://127.0.0.1:8787/api/email-filter": (req: { body?: string | null }) => {
      filterConfig = JSON.parse(req.body ?? "{}") as typeof filterConfig;
      return { body: filterConfig };
    },
    "POST http://127.0.0.1:8787/api/imap/sync": () => ({
      body: { ok: true, synced: 0, accounts: imapAccounts },
    }),
    "POST http://127.0.0.1:8787/api/auth/logout": { body: { ok: true } },
  };

  return {
    sk,
    masterPassword,
    githubItem,
    imapAccounts,
    getFilterConfig: () => filterConfig,
    networkRoutes,
  };
}

describe("NonePwd App Headless UI & End-to-End Flows", () => {
  test("renders Unlock screen with default vault.yourdomain.com server and remember-duration selector", async () => {
    const app = await open("./App.tsx", {
      platform: "ios",
      network: {},
    });

    expect(app.value("id:server-url-input")).toBe("http://127.0.0.1:8787");
    expect(app.texts()).toContain("NonePwd");
    expect(app.texts()).toContain("3小时");
    expect(app.texts()).toContain("24小时");
    expect(app.texts()).toContain("7天");
    expect(app.texts()).toContain("仅本次");

    await app.press("7天");
    await app.type("id:secret-key-input", "NP3-AAAAAA-BBBBBB-CCCCCC-DDDDDD-EEEEEE");
    await app.press("初始化新服务端");
    expect(app.texts()).toContain("主账号邮箱");
    await app.press("解锁密码库");
    expect(app.texts()).toContain("Secret Key");
  });

  test("unlocks vault via encrypted API sync on Windows desktop and navigates 2FA, Vault, Inbox, and Multi-IMAP Settings", async () => {
    const fx = await buildTestVaultFixture();

    const desktopApp = await open("./App.tsx", {
      platform: "windows",
      width: 1100,
      height: 760,
      network: fx.networkRoutes,
    });

    await desktopApp.type("id:secret-key-input", fx.sk);
    await desktopApp.type("id:master-password-input", fx.masterPassword);
    await desktopApp.press("id:unlock-button");
    await desktopApp.waitFor("text:GitHub");

    // 1. 2FA Tab shows live 6-digit code & copies on press
    const expectedCode = (await generateTotp(fx.githubItem.totp!, Date.now())).code;
    await desktopApp.waitFor(`text:${expectedCode}`);
    await desktopApp.press("GitHub");
    expect(desktopApp.clipboard()).toBe(expectedCode);

    // 2. QR / Text 2FA import sheet parses otpauth:// URI
    await desktopApp.press("id:totp-import-btn");
    await desktopApp.waitFor("text:导入 2FA 验证器");
    await desktopApp.press("粘贴 / 文本");
    await desktopApp.type(
      "id:qr-paste-input",
      "otpauth://totp/Cloudflare:ops@example.com?secret=JBSWY3DPEHPK3PXP&issuer=Cloudflare"
    );
    await desktopApp.press("解析预览");
    await desktopApp.waitFor("text:Cloudflare");
    await desktopApp.press("关闭");

    // 3. Vault Tab filters, opens detail, and creates a new encrypted item
    await desktopApp.press("密码库");
    await desktopApp.waitFor("text:LegacyForum");
    await desktopApp.press("GitHub");
    await desktopApp.waitFor("text:alice@github.com");
    await desktopApp.press("id:vault-add-btn");
    await desktopApp.waitFor("text:新建条目");
    await desktopApp.type("id:item-title-input", "OpenAI");
    await desktopApp.press("生成强密码");
    await desktopApp.press("加密并保存");
    await desktopApp.waitFor("text:OpenAI");

    // 4. Inbox Tab shows decrypted email OTP & multi-mailbox filter & Sync
    await desktopApp.press("收件箱");
    await desktopApp.waitFor("text:839204");
    expect(desktopApp.texts().some((t) => t.includes("work@gmail.com"))).toBe(true);
    await desktopApp.press("id:sync-imap-btn");
    expect(
      desktopApp.requests().some((r) => r.method === "POST" && r.url.endsWith("/api/imap/sync"))
    ).toBe(true);

    // 5. Settings Tab shows unlimited same-provider IMAP accounts, adds 3rd Gmail, toggles otpOnly, & shows audit
    await desktopApp.press("设置");
    await desktopApp.waitFor("text:多邮箱 IMAP 收信");
    expect(desktopApp.texts()).toContain("工作 Gmail");
    expect(desktopApp.texts()).toContain("个人 Gmail");
    await desktopApp.press("id:add-imap-btn");
    await desktopApp.waitFor("text:添加 IMAP 收信邮箱");
    await desktopApp.press("Gmail");
    await desktopApp.type("you@gmail.com", "third@gmail.com");
    await desktopApp.type("输入授权码", "app-pass-3");
    await desktopApp.press("保存账号");
    await desktopApp.waitFor("text:third@gmail.com · imap.gmail.com:993");
    expect(fx.imapAccounts).toHaveLength(3);

    await desktopApp.press("id:otp-only-switch");
    expect(fx.getFilterConfig().otpOnly).toBe(true);
    expect(desktopApp.texts()).toContain("弱密码");
    expect(desktopApp.texts()).toContain("未开 2FA");

    // Lock returns to unlock screen
    await desktopApp.press("id:lock-vault-btn");
    await desktopApp.waitFor("id:unlock-button");
  });

  test("mobile iOS and Android flows: unlock, live TOTP copy, Picker QR trigger, and back-button sheet dismiss", async () => {
    const fx = await buildTestVaultFixture();

    const iosApp = await open("./App.tsx", {
      platform: "ios",
      network: fx.networkRoutes,
    });
    iosApp.onPick(() => null);

    await iosApp.type("id:secret-key-input", fx.sk);
    await iosApp.type("id:master-password-input", fx.masterPassword);
    await iosApp.press("id:unlock-button");
    await iosApp.waitFor("text:GitHub");

    const expectedCode = (await generateTotp(fx.githubItem.totp!, Date.now())).code;
    await iosApp.waitFor(`text:${expectedCode}`);
    await iosApp.press("GitHub");
    expect(iosApp.clipboard()).toBe(expectedCode);

    // Verify Picker.pickImages request fires from 相册选图 mode & back() closes sheet
    await iosApp.press("id:totp-import-btn");
    await iosApp.waitFor("text:从相册选择二维码图片");
    await iosApp.press("从相册选择二维码图片");
    expect(iosApp.picks()).toHaveLength(1);
    expect(iosApp.picks()[0]).toMatchObject({ kind: "images", multiple: true });
    await iosApp.back();
    await iosApp.waitFor("text:导入 2FA 验证器", { state: "gone" });

    // Android platform unlock + back-button modal dismiss
    const androidApp = await open("./App.tsx", {
      platform: "android",
      network: fx.networkRoutes,
    });
    await androidApp.type("id:secret-key-input", fx.sk);
    await androidApp.type("id:master-password-input", fx.masterPassword);
    await androidApp.press("id:unlock-button");
    await androidApp.waitFor("text:GitHub");
    await androidApp.press("id:totp-import-btn");
    await androidApp.waitFor("text:导入 2FA 验证器");
    await androidApp.back();
    await androidApp.waitFor("text:导入 2FA 验证器", { state: "gone" });
  });
});
