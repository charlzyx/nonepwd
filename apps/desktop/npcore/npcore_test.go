package npcore

import (
	"testing"
	"time"
)

func TestAsukaPluginLoadsAndCryptoOps(t *testing.T) {
	path, viaPlugin, err := LoadedInfo()
	if err != nil {
		t.Fatalf("LoadedInfo failed: %v", err)
	}
	t.Logf("Loaded libnonepwd_core.dylib from %s (viaAsukaPlugin=%v)", path, viaPlugin)
	if !viaPlugin {
		t.Fatalf("expected dylib to resolve via Asuka plugin.LibraryPath, got fallback %s", path)
	}

	sk, err := GenerateSecretKey()
	if err != nil {
		t.Fatalf("GenerateSecretKey: %v", err)
	}
	if len(sk) < 10 || sk[:4] != "NP3-" {
		t.Fatalf("unexpected secret key format: %q", sk)
	}

	saltB64, err := RandomBytesB64(16)
	if err != nil {
		t.Fatalf("RandomBytesB64: %v", err)
	}

	keys1, err := DeriveAccountKeys("MasterPass#2026", sk, saltB64, 10_000)
	if err != nil {
		t.Fatalf("DeriveAccountKeys: %v", err)
	}
	keys2, err := DeriveAccountKeys("MasterPass#2026", sk, saltB64, 10_000)
	if err != nil {
		t.Fatalf("DeriveAccountKeys repeat: %v", err)
	}
	if keys1.MasterUnlockKeyB64 != keys2.MasterUnlockKeyB64 || keys1.AuthVerifierB64 != keys2.AuthVerifierB64 {
		t.Fatalf("DeriveAccountKeys mismatch")
	}

	// Encrypt & decrypt VaultItemPayload with Card + Identity fields and AAD.
	item := VaultItemPayload{
		ID:       "item-1",
		VaultID:  "vault-1",
		Category: CategoryIdentity,
		Title:    "张三身份信息",
		Tags:     []string{"personal"},
		URLs:     []string{"https://example.com"},
		Card: &CardDetails{
			CardholderName: "ZHANG SAN",
			Number:         "4111222233334444",
			ExpMonth:       "08",
			ExpYear:        "2029",
			CVV:            "123",
			Brand:          "Visa",
		},
		Identity: &IdentityDetails{
			FullName:   "张三",
			Email:      "zhangsan@example.com",
			Phone:      "+86 13800138000",
			Address1:   "中关村大街 1 号",
			City:       "北京",
			PostalCode: "100080",
			Country:    "CN",
		},
		CustomFields: []CustomField{},
		CreatedAt:    "2026-01-01T00:00:00Z",
		UpdatedAt:    "2026-01-01T00:00:00Z",
	}
	aad := AADVaultItem("vault-1", "item-1")
	blob, err := EncryptJSON(keys1.MasterUnlockKeyB64, item, aad)
	if err != nil {
		t.Fatalf("EncryptJSON: %v", err)
	}
	dec, err := DecryptJSON[VaultItemPayload](keys1.MasterUnlockKeyB64, blob, aad)
	if err != nil {
		t.Fatalf("DecryptJSON: %v", err)
	}
	if dec.Title != item.Title || dec.Category != CategoryIdentity || dec.Card == nil || dec.Card.Number != "4111222233334444" || dec.Identity == nil || dec.Identity.FullName != "张三" {
		t.Fatalf("decrypted item mismatch: %+v", dec)
	}
	if _, err := DecryptJSON[VaultItemPayload](keys1.MasterUnlockKeyB64, blob, AADVaultItem("vault-2", "item-1")); err == nil {
		t.Fatalf("expected AAD mismatch error")
	}

	// RFC 6238 TOTP check via Rust core.
	totpRes, err := GenerateTOTP("GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQ", time.UnixMilli(59_000))
	if err != nil {
		t.Fatalf("GenerateTOTP: %v", err)
	}
	if totpRes.Code != "287082" {
		t.Fatalf("expected RFC6238 TOTP 287082, got %s", totpRes.Code)
	}
}
