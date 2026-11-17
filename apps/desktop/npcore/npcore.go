// Package npcore is an Asuka plugin wrapping the Rust nonepwd-core cdylib
// via Asuka's plugin.LibraryPath + purego (zero cgo).
package npcore

import (
	_ "embed"
	"encoding/base64"
	"encoding/json"
	"errors"
	"fmt"
	"os"
	"path/filepath"
	"runtime"
	"sync"
	"time"
	"unsafe"

	"github.com/ebitengine/purego"
	"github.com/egoist/asuka/plugin"
)

//go:embed asuka-plugin.json
var manifestJSON []byte

const (
	DefaultKDFIterations = 600_000
	EmailSealInfo        = "nonepwd-email-v1"
	AADRootKeyset        = "nonepwd:root-keyset:v1"
)

func AADVaultMeta(vaultID string) string {
	return fmt.Sprintf("nonepwd:vault:%s:meta", vaultID)
}

func AADVaultOwnerKey(vaultID string) string {
	return fmt.Sprintf("nonepwd:vault:%s:owner-key", vaultID)
}

func AADVaultSAKey(vaultID, serviceAccountID string) string {
	return fmt.Sprintf("nonepwd:vault:%s:sa:%s", vaultID, serviceAccountID)
}

func AADVaultItem(vaultID, itemID string) string {
	return fmt.Sprintf("nonepwd:vault:%s:item:%s", vaultID, itemID)
}

type ItemCategory string

const (
	CategoryLogin         ItemCategory = "login"
	CategoryAPICredential ItemCategory = "api_credential"
	CategorySecureNote    ItemCategory = "secure_note"
	CategorySSHKey        ItemCategory = "ssh_key"
	CategoryCard          ItemCategory = "card"
	CategoryIdentity      ItemCategory = "identity"
)

type VaultMetadata struct {
	Name        string `json:"name"`
	Description string `json:"description,omitempty"`
	Icon        string `json:"icon,omitempty"`
	Color       string `json:"color,omitempty"`
}

type CardDetails struct {
	CardholderName string `json:"cardholderName,omitempty"`
	Number         string `json:"number,omitempty"`
	ExpMonth       string `json:"expMonth,omitempty"`
	ExpYear        string `json:"expYear,omitempty"`
	CVV            string `json:"cvv,omitempty"`
	Brand          string `json:"brand,omitempty"`
}

func (c *CardDetails) IsEmpty() bool {
	if c == nil {
		return true
	}
	return c.CardholderName == "" &&
		c.Number == "" &&
		c.ExpMonth == "" &&
		c.ExpYear == "" &&
		c.CVV == "" &&
		c.Brand == ""
}

type IdentityDetails struct {
	FullName   string `json:"fullName,omitempty"`
	FirstName  string `json:"firstName,omitempty"`
	LastName   string `json:"lastName,omitempty"`
	Email      string `json:"email,omitempty"`
	Phone      string `json:"phone,omitempty"`
	Company    string `json:"company,omitempty"`
	Address1   string `json:"address1,omitempty"`
	Address2   string `json:"address2,omitempty"`
	City       string `json:"city,omitempty"`
	State      string `json:"state,omitempty"`
	PostalCode string `json:"postalCode,omitempty"`
	Country    string `json:"country,omitempty"`
}

func (id *IdentityDetails) IsEmpty() bool {
	if id == nil {
		return true
	}
	return id.FullName == "" &&
		id.FirstName == "" &&
		id.LastName == "" &&
		id.Email == "" &&
		id.Phone == "" &&
		id.Company == "" &&
		id.Address1 == "" &&
		id.Address2 == "" &&
		id.City == "" &&
		id.State == "" &&
		id.PostalCode == "" &&
		id.Country == ""
}

type CustomField struct {
	ID    string `json:"id"`
	Label string `json:"label"`
	Value string `json:"value"`
	Type  string `json:"type"`
}

type VaultItemPayload struct {
	ID           string           `json:"id"`
	VaultID      string           `json:"vaultId"`
	Category     ItemCategory     `json:"category"`
	Title        string           `json:"title"`
	Favorite     bool             `json:"favorite"`
	Tags         []string         `json:"tags"`
	URLs         []string         `json:"urls"`
	Username     string           `json:"username,omitempty"`
	Password     string           `json:"password,omitempty"`
	TOTP         string           `json:"totp,omitempty"`
	EmailAlias   string           `json:"emailAlias,omitempty"`
	Notes        string           `json:"notes,omitempty"`
	Card         *CardDetails     `json:"card,omitempty"`
	Identity     *IdentityDetails `json:"identity,omitempty"`
	CustomFields []CustomField    `json:"customFields"`
	CreatedAt    string           `json:"createdAt"`
	UpdatedAt    string           `json:"updatedAt"`
	LastUsedAt   string           `json:"lastUsedAt,omitempty"`
}

func (p *VaultItemPayload) Normalize() {
	if p.Tags == nil {
		p.Tags = []string{}
	}
	if p.URLs == nil {
		p.URLs = []string{}
	}
	if p.CustomFields == nil {
		p.CustomFields = []CustomField{}
	}
	if p.Card != nil && p.Card.IsEmpty() {
		p.Card = nil
	}
	if p.Identity != nil && p.Identity.IsEmpty() {
		p.Identity = nil
	}
}

type RootKeysetPayload struct {
	RootKeyB64              string `json:"rootKeyB64"`
	EmailPrivateKeyPkcs8B64 string `json:"emailPrivateKeyPkcs8B64"`
}

type SealedEnvelope struct {
	V   uint8  `json:"v"`
	EPK string `json:"epk"`
	IV  string `json:"iv"`
	CT  string `json:"ct"`
}

type DecryptedEmailPayload struct {
	ID           string  `json:"id,omitempty"`
	From         string  `json:"from"`
	To           string  `json:"to"`
	Subject      string  `json:"subject"`
	Snippet      string  `json:"snippet"`
	TextBody     string  `json:"textBody"`
	OTPCode      *string `json:"otpCode"`
	Confidence   float64 `json:"confidence"`
	MagicLink    *string `json:"magicLink"`
	SenderDomain string  `json:"senderDomain"`
	ReceivedAt   string  `json:"receivedAt"`
}

type DerivedAccountKeys struct {
	MasterUnlockKeyB64 string `json:"masterUnlockKeyB64"`
	AuthVerifierB64    string `json:"authVerifierB64"`
}

type EmailKeyPair struct {
	PublicKeyB64       string `json:"publicKeyB64"`
	PrivateKeyPkcs8B64 string `json:"privateKeyPkcs8B64"`
}

type TOTPResult struct {
	Code             string  `json:"code"`
	Period           uint64  `json:"period"`
	RemainingSeconds uint64  `json:"remainingSeconds"`
	Progress         float64 `json:"progress"`
}

type libBindings struct {
	handle         uintptr
	path           string
	viaAsukaPlugin bool
	alloc          func(len uintptr) *byte
	dealloc        func(ptr *byte, len uintptr)
	invokeNative   func(inPtr *byte, inLen uintptr, outLen *uintptr) *byte
	freeResult     func(ptr *byte, len uintptr)
}

var (
	loadOnce sync.Once
	loaded   *libBindings
	loadErr  error
)

func resolveLibraryPath() (string, bool, error) {
	// Primary path: Asuka's official plugin resolver (handles asuka build .app
	// bundles as well as go run / go test / asuka dev with StoreBuild output).
	if p, err := plugin.LibraryPath(manifestJSON, "nonepwd_core"); err == nil && p != "" {
		if _, statErr := os.Stat(p); statErr == nil {
			return p, true, nil
		}
	}

	// Fallback search paths if SourceHash drifted during local iteration or custom test binary paths.
	var candidates []string
	if envPath := os.Getenv("NONEPWD_CORE_DYLIB"); envPath != "" {
		candidates = append(candidates, envPath)
	}
	if exe, err := os.Executable(); err == nil {
		exeDir := filepath.Dir(exe)
		candidates = append(candidates,
			filepath.Join(exeDir, "..", "Frameworks", "libnonepwd_core.dylib"),
			filepath.Join(exeDir, "..", "Resources", "libnonepwd_core.dylib"),
			filepath.Join(exeDir, "libnonepwd_core.dylib"),
		)
	}
	if _, callerFile, _, ok := runtime.Caller(0); ok {
		pkgDir := filepath.Dir(callerFile)
		candidates = append(candidates,
			filepath.Join(pkgDir, "build", "darwin", "libnonepwd_core.dylib"),
		)
	}
	for _, c := range candidates {
		if _, err := os.Stat(c); err == nil {
			return c, false, nil
		}
	}
	return "", false, errors.New("libnonepwd_core.dylib not found via Asuka plugin.LibraryPath or fallback paths (run `go run ./cmd/buildplugin`)")
}

func getLib() (*libBindings, error) {
	loadOnce.Do(func() {
		libPath, viaPlugin, err := resolveLibraryPath()
		if err != nil {
			loadErr = err
			return
		}
		handle, err := purego.Dlopen(libPath, purego.RTLD_NOW|purego.RTLD_LOCAL)
		if err != nil {
			loadErr = fmt.Errorf("purego.Dlopen(%s): %w", libPath, err)
			return
		}
		b := &libBindings{
			handle:         handle,
			path:           libPath,
			viaAsukaPlugin: viaPlugin,
		}
		purego.RegisterLibFunc(&b.alloc, handle, "np_alloc")
		purego.RegisterLibFunc(&b.dealloc, handle, "np_dealloc")
		purego.RegisterLibFunc(&b.invokeNative, handle, "np_invoke_native")
		purego.RegisterLibFunc(&b.freeResult, handle, "np_free_result")
		loaded = b
	})
	return loaded, loadErr
}

// LoadedInfo returns the loaded dylib path and whether it resolved through Asuka's plugin.LibraryPath.
func LoadedInfo() (path string, viaAsukaPlugin bool, err error) {
	b, err := getLib()
	if err != nil {
		return "", false, err
	}
	return b.path, b.viaAsukaPlugin, nil
}

type invokeReq struct {
	Op   string `json:"op"`
	Args any    `json:"args"`
}

type invokeResp struct {
	OK     bool            `json:"ok"`
	Result json.RawMessage `json:"result,omitempty"`
	Error  string          `json:"error,omitempty"`
}

// Invoke calls an operation on the Rust nonepwd-core library via its JSON C ABI.
func Invoke(op string, args any, out any) error {
	lib, err := getLib()
	if err != nil {
		return err
	}
	if args == nil {
		args = struct{}{}
	}
	reqBytes, err := json.Marshal(invokeReq{Op: op, Args: args})
	if err != nil {
		return fmt.Errorf("marshal %s args: %w", op, err)
	}
	if len(reqBytes) == 0 {
		return errors.New("empty invoke payload")
	}

	inLen := uintptr(len(reqBytes))
	inPtr := lib.alloc(inLen)
	if inPtr == nil {
		return errors.New("np_alloc returned null")
	}
	defer lib.dealloc(inPtr, inLen)
	copy(unsafe.Slice(inPtr, len(reqBytes)), reqBytes)

	var outLen uintptr
	outPtr := lib.invokeNative(inPtr, inLen, &outLen)
	if outPtr != nil {
		defer lib.freeResult(outPtr, outLen)
	}
	if outPtr == nil || outLen == 0 {
		runtime.KeepAlive(&outLen)
		return fmt.Errorf("np_invoke_native(%s) returned empty buffer", op)
	}

	respBytes := make([]byte, int(outLen))
	copy(respBytes, unsafe.Slice(outPtr, int(outLen)))
	runtime.KeepAlive(&outLen)

	var resp invokeResp
	if err := json.Unmarshal(respBytes, &resp); err != nil {
		return fmt.Errorf("unmarshal %s response: %w", op, err)
	}
	if !resp.OK {
		if resp.Error != "" {
			return errors.New(resp.Error)
		}
		return fmt.Errorf("nonepwd-core op %q failed", op)
	}
	if out != nil && len(resp.Result) > 0 {
		if err := json.Unmarshal(resp.Result, out); err != nil {
			return fmt.Errorf("decode %s result: %w", op, err)
		}
	}
	return nil
}

func ToBase64URL(b []byte) string {
	return base64.RawURLEncoding.EncodeToString(b)
}

func FromBase64URL(s string) ([]byte, error) {
	return base64.RawURLEncoding.DecodeString(s)
}

func RandomBytesB64(length int) (string, error) {
	var out string
	err := Invoke("random_bytes", map[string]any{"len": length}, &out)
	return out, err
}

func RandomID() (string, error) {
	var out string
	err := Invoke("random_id", struct{}{}, &out)
	return out, err
}

func GenerateSecretKey() (string, error) {
	var out string
	err := Invoke("generate_secret_key", struct{}{}, &out)
	return out, err
}

func NormalizeSecretKey(secretKey string) (string, error) {
	var out string
	err := Invoke("normalize_secret_key", map[string]any{"secretKey": secretKey}, &out)
	return out, err
}

func DeriveAccountKeys(masterPassword, secretKey, kdfSaltB64 string, iterations int) (DerivedAccountKeys, error) {
	var out DerivedAccountKeys
	err := Invoke("derive_account_keys", map[string]any{
		"masterPassword": masterPassword,
		"secretKey":      secretKey,
		"kdfSaltB64":     kdfSaltB64,
		"iterations":     iterations,
	}, &out)
	return out, err
}

func EncryptBytesB64(keyB64, plaintextB64, aad string) (string, error) {
	args := map[string]any{
		"keyB64":       keyB64,
		"plaintextB64": plaintextB64,
	}
	if aad != "" {
		args["aad"] = aad
	}
	var blob string
	err := Invoke("encrypt_bytes", args, &blob)
	return blob, err
}

func DecryptBytesB64(keyB64, blob, aad string) (string, error) {
	args := map[string]any{
		"keyB64": keyB64,
		"blob":   blob,
	}
	if aad != "" {
		args["aad"] = aad
	}
	var ptB64 string
	err := Invoke("decrypt_bytes", args, &ptB64)
	return ptB64, err
}

func EncryptJSON(keyB64 string, v any, aad string) (string, error) {
	raw, err := json.Marshal(v)
	if err != nil {
		return "", err
	}
	return EncryptBytesB64(keyB64, ToBase64URL(raw), aad)
}

func DecryptJSON[T any](keyB64, blob, aad string) (T, error) {
	var zero T
	ptB64, err := DecryptBytesB64(keyB64, blob, aad)
	if err != nil {
		return zero, err
	}
	raw, err := FromBase64URL(ptB64)
	if err != nil {
		return zero, err
	}
	var out T
	if err := json.Unmarshal(raw, &out); err != nil {
		return zero, err
	}
	return out, nil
}

func GenerateEmailKeyPair() (EmailKeyPair, error) {
	var out EmailKeyPair
	err := Invoke("generate_email_key_pair", struct{}{}, &out)
	return out, err
}

func OpenSealedJSON[T any](privateKeyPkcs8B64 string, env SealedEnvelope) (T, error) {
	var zero T
	var ptB64 string
	err := Invoke("open_sealed_envelope", map[string]any{
		"privateKeyPkcs8B64": privateKeyPkcs8B64,
		"envelope":           env,
		"info":               EmailSealInfo,
	}, &ptB64)
	if err != nil {
		return zero, err
	}
	raw, err := FromBase64URL(ptB64)
	if err != nil {
		return zero, err
	}
	var out T
	if err := json.Unmarshal(raw, &out); err != nil {
		return zero, err
	}
	return out, nil
}

func GenerateTOTP(input string, now time.Time) (TOTPResult, error) {
	var out TOTPResult
	err := Invoke("generate_totp", map[string]any{
		"input":       input,
		"timestampMs": uint64(now.UnixMilli()),
	}, &out)
	return out, err
}

func GeneratePassword(length int) (string, error) {
	var out string
	err := Invoke("generate_password", map[string]any{"length": length}, &out)
	return out, err
}

func GeneratePassphrase(words int) (string, error) {
	var out string
	err := Invoke("generate_passphrase", map[string]any{"words": words}, &out)
	return out, err
}

func DomainsMatch(a, b string) bool {
	var out bool
	if err := Invoke("domains_match", map[string]any{"a": a, "b": b}, &out); err != nil {
		return false
	}
	return out
}
