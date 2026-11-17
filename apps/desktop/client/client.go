package client

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net/http"
	"net/url"
	"strings"
	"sync"
	"time"

	"github.com/coder/websocket"

	"desktop/npcore"
)

type AuthParamsResponse struct {
	Initialized   bool   `json:"initialized"`
	Email         string `json:"email,omitempty"`
	KDFSalt       string `json:"kdfSalt,omitempty"`
	KDFIterations int    `json:"kdfIterations,omitempty"`
	StaticSite    bool   `json:"staticSite,omitempty"`
}

type AccountInfo struct {
	Email               string `json:"email"`
	EncryptedRootKeyset string `json:"encryptedRootKeyset,omitempty"`
	EmailPublicKey      string `json:"emailPublicKey"`
	CFWebhookSecret     string `json:"cfWebhookSecret"`
	AliasDomain         string `json:"aliasDomain"`
}

type EncryptedVaultRecord struct {
	ID            string `json:"id"`
	EncryptedKey  string `json:"encryptedKey"`
	EncryptedMeta string `json:"encryptedMeta"`
	CreatedAt     string `json:"createdAt"`
	UpdatedAt     string `json:"updatedAt"`
}

type EncryptedItemRecord struct {
	ID            string `json:"id"`
	VaultID       string `json:"vaultId"`
	EncryptedData string `json:"encryptedData"`
	CreatedAt     string `json:"createdAt"`
	UpdatedAt     string `json:"updatedAt"`
	Version       int    `json:"version"`
}

type AliasRecord struct {
	ID            string  `json:"id"`
	Address       string  `json:"address"`
	SiteDomain    *string `json:"siteDomain"`
	VaultID       *string `json:"vaultId"`
	ItemID        *string `json:"itemId"`
	Enabled       bool    `json:"enabled"`
	ReceivedCount int     `json:"receivedCount"`
	CreatedAt     string  `json:"createdAt"`
}

type EncryptedEmailRecord struct {
	ID             string                `json:"id"`
	Source         string                `json:"source"`
	EnvelopeTo     *string               `json:"envelopeTo"`
	HasOTP         bool                  `json:"hasOtp"`
	SealedEnvelope npcore.SealedEnvelope `json:"sealedEnvelope"`
	ReceivedAt     string                `json:"receivedAt"`
}

type DecryptedVault struct {
	ID        string               `json:"id"`
	Metadata  npcore.VaultMetadata `json:"metadata"`
	KeyB64    string               `json:"-"`
	CreatedAt string               `json:"createdAt"`
	UpdatedAt string               `json:"updatedAt"`
}

type DecryptedEmail struct {
	ID           string   `json:"id"`
	Source       string   `json:"source"`
	EnvelopeTo   string   `json:"envelopeTo,omitempty"`
	From         string   `json:"from"`
	To           string   `json:"to"`
	Subject      string   `json:"subject"`
	Snippet      string   `json:"snippet"`
	TextBody     string   `json:"textBody"`
	OTPCode      string   `json:"otpCode,omitempty"`
	Confidence   float64  `json:"confidence"`
	MagicLink    string   `json:"magicLink,omitempty"`
	SenderDomain string   `json:"senderDomain"`
	ReceivedAt   string   `json:"receivedAt"`
}

type SyncSnapshot struct {
	Account AccountInfo
	Vaults  []DecryptedVault
	Items   []npcore.VaultItemPayload
	Aliases []AliasRecord
	Emails  []DecryptedEmail
}

type PushEvent struct {
	Type        string
	WSConnected *bool
	Email       *DecryptedEmail
	Snapshot    *SyncSnapshot
}

type Client struct {
	mu             sync.RWMutex
	serverURL      string
	httpClient     *http.Client
	sessionToken   string
	rootKeyB64     string
	emailPrivKey   string
	vaultKeys      map[string]string
	account        AccountInfo
	vaults         []DecryptedVault
	items          []npcore.VaultItemPayload
	aliases        []AliasRecord
	emails         []DecryptedEmail
	wsCancel       context.CancelFunc
	onPush         func(PushEvent)
}

func New(serverURL string) *Client {
	return &Client{
		serverURL: NormalizeServerURL(serverURL),
		httpClient: &http.Client{
			Timeout: 20 * time.Second,
		},
		vaultKeys: make(map[string]string),
	}
}

func (c *Client) SetServerURL(serverURL string) {
	c.mu.Lock()
	c.serverURL = NormalizeServerURL(serverURL)
	c.mu.Unlock()
}

func (c *Client) ServerURL() string {
	c.mu.RLock()
	defer c.mu.RUnlock()
	return c.serverURL
}

func (c *Client) SetOnPush(fn func(PushEvent)) {
	c.mu.Lock()
	c.onPush = fn
	c.mu.Unlock()
}

func (c *Client) Unlocked() bool {
	c.mu.RLock()
	defer c.mu.RUnlock()
	return c.sessionToken != "" && c.rootKeyB64 != ""
}

func (c *Client) Snapshot() SyncSnapshot {
	c.mu.RLock()
	defer c.mu.RUnlock()
	return SyncSnapshot{
		Account: c.account,
		Vaults:  append([]DecryptedVault(nil), c.vaults...),
		Items:   append([]npcore.VaultItemPayload(nil), c.items...),
		Aliases: append([]AliasRecord(nil), c.aliases...),
		Emails:  append([]DecryptedEmail(nil), c.emails...),
	}
}

func (c *Client) doJSON(ctx context.Context, method, path string, body any, out any) error {
	c.mu.RLock()
	baseURL := c.serverURL
	token := c.sessionToken
	c.mu.RUnlock()

	var reqBody io.Reader
	if body != nil {
		raw, err := json.Marshal(body)
		if err != nil {
			return err
		}
		reqBody = bytes.NewReader(raw)
	}

	req, err := http.NewRequestWithContext(ctx, method, baseURL+path, reqBody)
	if err != nil {
		return err
	}
	if token != "" {
		req.Header.Set("Authorization", "Bearer "+token)
	}
	if body != nil {
		req.Header.Set("Content-Type", "application/json")
	}

	resp, err := c.httpClient.Do(req)
	if err != nil {
		return err
	}
	defer resp.Body.Close()

	respBytes, err := io.ReadAll(resp.Body)
	if err != nil {
		return err
	}
	if resp.StatusCode < 200 || resp.StatusCode >= 300 {
		var apiErr struct {
			Error string `json:"error"`
		}
		if json.Unmarshal(respBytes, &apiErr) == nil && apiErr.Error != "" {
			return fmt.Errorf("%s (HTTP %d)", apiErr.Error, resp.StatusCode)
		}
		return fmt.Errorf("request %s %s failed: HTTP %d", method, path, resp.StatusCode)
	}
	if out != nil && len(respBytes) > 0 {
		if err := json.Unmarshal(respBytes, out); err != nil {
			return fmt.Errorf("decode %s response: %w", path, err)
		}
	}
	return nil
}

func (c *Client) CheckAuthParams(ctx context.Context) (AuthParamsResponse, error) {
	var res AuthParamsResponse
	err := c.doJSON(ctx, http.MethodGet, "/api/auth/params", nil, &res)
	return res, err
}

type SetupParams struct {
	Email          string
	MasterPassword string
	SecretKey      string
	AliasDomain    string
	KDFIterations  int
}

func (c *Client) SetupAccount(ctx context.Context, p SetupParams) (SyncSnapshot, error) {
	email := strings.TrimSpace(strings.ToLower(p.Email))
	if email == "" {
		return SyncSnapshot{}, errors.New("请输入邮箱地址")
	}
	if p.MasterPassword == "" {
		return SyncSnapshot{}, errors.New("请输入主密码")
	}
	secretKey := strings.TrimSpace(p.SecretKey)
	if secretKey == "" {
		var err error
		secretKey, err = npcore.GenerateSecretKey()
		if err != nil {
			return SyncSnapshot{}, err
		}
	}
	iters := p.KDFIterations
	if iters <= 0 {
		iters = npcore.DefaultKDFIterations
	}

	kdfSalt, err := npcore.RandomBytesB64(16)
	if err != nil {
		return SyncSnapshot{}, err
	}
	derived, err := npcore.DeriveAccountKeys(p.MasterPassword, secretKey, kdfSalt, iters)
	if err != nil {
		return SyncSnapshot{}, err
	}
	rootKeyB64, err := npcore.RandomBytesB64(32)
	if err != nil {
		return SyncSnapshot{}, err
	}
	emailKP, err := npcore.GenerateEmailKeyPair()
	if err != nil {
		return SyncSnapshot{}, err
	}
	keyset := npcore.RootKeysetPayload{
		RootKeyB64:              rootKeyB64,
		EmailPrivateKeyPkcs8B64: emailKP.PrivateKeyPkcs8B64,
	}
	encryptedRootKeyset, err := npcore.EncryptJSON(derived.MasterUnlockKeyB64, keyset, npcore.AADRootKeyset)
	if err != nil {
		return SyncSnapshot{}, err
	}

	initialDefs := []npcore.VaultMetadata{
		{Name: "Personal", Description: "个人网站登录、银行卡与身份信息"},
		{Name: "DevOps", Description: "API 密钥、服务器与 CLI 凭据"},
	}
	type setupVault struct {
		ID            string `json:"id"`
		EncryptedKey  string `json:"encryptedKey"`
		EncryptedMeta string `json:"encryptedMeta"`
	}
	var initialVaults []setupVault
	for _, meta := range initialDefs {
		vid, err := npcore.RandomID()
		if err != nil {
			return SyncSnapshot{}, err
		}
		vkB64, err := npcore.RandomBytesB64(32)
		if err != nil {
			return SyncSnapshot{}, err
		}
		encKey, err := npcore.EncryptBytesB64(rootKeyB64, vkB64, npcore.AADVaultOwnerKey(vid))
		if err != nil {
			return SyncSnapshot{}, err
		}
		encMeta, err := npcore.EncryptJSON(vkB64, meta, npcore.AADVaultMeta(vid))
		if err != nil {
			return SyncSnapshot{}, err
		}
		initialVaults = append(initialVaults, setupVault{
			ID:            vid,
			EncryptedKey:  encKey,
			EncryptedMeta: encMeta,
		})
	}

	var setupRes struct {
		Token   string      `json:"token"`
		Account AccountInfo `json:"account"`
	}
	err = c.doJSON(ctx, http.MethodPost, "/api/auth/setup", map[string]any{
		"email":               email,
		"kdfSalt":             kdfSalt,
		"kdfIterations":       iters,
		"authVerifier":        derived.AuthVerifierB64,
		"encryptedRootKeyset": encryptedRootKeyset,
		"emailPublicKey":      emailKP.PublicKeyB64,
		"aliasDomain":         strings.TrimSpace(p.AliasDomain),
		"vaults":              initialVaults,
	}, &setupRes)
	if err != nil {
		return SyncSnapshot{}, err
	}

	c.mu.Lock()
	c.sessionToken = setupRes.Token
	c.rootKeyB64 = rootKeyB64
	c.emailPrivKey = emailKP.PrivateKeyPkcs8B64
	c.account = setupRes.Account
	c.mu.Unlock()

	return c.Sync(ctx)
}

func (c *Client) Unlock(ctx context.Context, secretKey, masterPassword string) (SyncSnapshot, error) {
	if strings.TrimSpace(secretKey) == "" {
		return SyncSnapshot{}, errors.New("请输入 Secret Key (NP3-...)")
	}
	if masterPassword == "" {
		return SyncSnapshot{}, errors.New("请输入主密码")
	}

	params, err := c.CheckAuthParams(ctx)
	if err != nil {
		return SyncSnapshot{}, err
	}
	if !params.Initialized || params.KDFSalt == "" || params.KDFIterations <= 0 {
		return SyncSnapshot{}, errors.New("该服务端尚未初始化密码库")
	}

	derived, err := npcore.DeriveAccountKeys(masterPassword, secretKey, params.KDFSalt, params.KDFIterations)
	if err != nil {
		return SyncSnapshot{}, fmt.Errorf("密钥派生失败: %w", err)
	}

	var loginRes struct {
		Token   string      `json:"token"`
		Account AccountInfo `json:"account"`
	}
	if err := c.doJSON(ctx, http.MethodPost, "/api/auth/login", map[string]any{
		"authVerifier": derived.AuthVerifierB64,
	}, &loginRes); err != nil {
		return SyncSnapshot{}, err
	}

	keyset, err := npcore.DecryptJSON[npcore.RootKeysetPayload](
		derived.MasterUnlockKeyB64,
		loginRes.Account.EncryptedRootKeyset,
		npcore.AADRootKeyset,
	)
	if err != nil {
		return SyncSnapshot{}, fmt.Errorf("解密根密钥集失败（Secret Key 或主密码不匹配）: %w", err)
	}

	c.mu.Lock()
	c.sessionToken = loginRes.Token
	c.rootKeyB64 = keyset.RootKeyB64
	c.emailPrivKey = keyset.EmailPrivateKeyPkcs8B64
	c.account = loginRes.Account
	c.mu.Unlock()

	return c.Sync(ctx)
}

func (c *Client) decryptEmailRecord(rec EncryptedEmailRecord) (DecryptedEmail, bool) {
	c.mu.RLock()
	priv := c.emailPrivKey
	c.mu.RUnlock()
	if priv == "" {
		return DecryptedEmail{}, false
	}
	opened, err := npcore.OpenSealedJSON[npcore.DecryptedEmailPayload](priv, rec.SealedEnvelope)
	if err != nil {
		return DecryptedEmail{}, false
	}
	out := DecryptedEmail{
		ID:           rec.ID,
		Source:       rec.Source,
		From:         opened.From,
		To:           opened.To,
		Subject:      opened.Subject,
		Snippet:      opened.Snippet,
		TextBody:     opened.TextBody,
		Confidence:   opened.Confidence,
		SenderDomain: opened.SenderDomain,
		ReceivedAt:   opened.ReceivedAt,
	}
	if rec.EnvelopeTo != nil {
		out.EnvelopeTo = *rec.EnvelopeTo
	}
	if opened.OTPCode != nil {
		out.OTPCode = *opened.OTPCode
	}
	if opened.MagicLink != nil {
		out.MagicLink = *opened.MagicLink
	}
	if out.ReceivedAt == "" {
		out.ReceivedAt = rec.ReceivedAt
	}
	return out, true
}

func (c *Client) Sync(ctx context.Context) (SyncSnapshot, error) {
	c.mu.RLock()
	rootKey := c.rootKeyB64
	token := c.sessionToken
	c.mu.RUnlock()
	if rootKey == "" || token == "" {
		return SyncSnapshot{}, errors.New("密码库已锁定")
	}

	var raw struct {
		Account AccountInfo            `json:"account"`
		Vaults  []EncryptedVaultRecord `json:"vaults"`
		Items   []EncryptedItemRecord  `json:"items"`
		Aliases []AliasRecord          `json:"aliases"`
		Emails  []EncryptedEmailRecord `json:"emails"`
	}
	if err := c.doJSON(ctx, http.MethodGet, "/api/sync", nil, &raw); err != nil {
		return SyncSnapshot{}, err
	}

	keyMap := make(map[string]string, len(raw.Vaults))
	vaults := make([]DecryptedVault, 0, len(raw.Vaults))
	for _, v := range raw.Vaults {
		vkB64, err := npcore.DecryptBytesB64(rootKey, v.EncryptedKey, npcore.AADVaultOwnerKey(v.ID))
		if err != nil {
			return SyncSnapshot{}, fmt.Errorf("解密密码库密钥失败 (%s): %w", v.ID, err)
		}
		meta, err := npcore.DecryptJSON[npcore.VaultMetadata](vkB64, v.EncryptedMeta, npcore.AADVaultMeta(v.ID))
		if err != nil {
			return SyncSnapshot{}, fmt.Errorf("解密密码库元数据失败 (%s): %w", v.ID, err)
		}
		keyMap[v.ID] = vkB64
		vaults = append(vaults, DecryptedVault{
			ID:        v.ID,
			Metadata:  meta,
			KeyB64:    vkB64,
			CreatedAt: v.CreatedAt,
			UpdatedAt: v.UpdatedAt,
		})
	}

	items := make([]npcore.VaultItemPayload, 0, len(raw.Items))
	for _, it := range raw.Items {
		vkB64, ok := keyMap[it.VaultID]
		if !ok {
			continue
		}
		payload, err := npcore.DecryptJSON[npcore.VaultItemPayload](vkB64, it.EncryptedData, npcore.AADVaultItem(it.VaultID, it.ID))
		if err != nil {
			continue
		}
		payload.Normalize()
		items = append(items, payload)
	}

	emails := make([]DecryptedEmail, 0, len(raw.Emails))
	for _, em := range raw.Emails {
		if opened, ok := c.decryptEmailRecord(em); ok {
			emails = append(emails, opened)
		}
	}

	c.mu.Lock()
	c.account = raw.Account
	c.vaultKeys = keyMap
	c.vaults = vaults
	c.items = items
	c.aliases = raw.Aliases
	c.emails = emails
	c.mu.Unlock()

	return c.Snapshot(), nil
}

func (c *Client) CreateVault(ctx context.Context, name, description string) (DecryptedVault, error) {
	c.mu.RLock()
	rootKey := c.rootKeyB64
	c.mu.RUnlock()
	if rootKey == "" {
		return DecryptedVault{}, errors.New("密码库已锁定")
	}
	id, err := npcore.RandomID()
	if err != nil {
		return DecryptedVault{}, err
	}
	vkB64, err := npcore.RandomBytesB64(32)
	if err != nil {
		return DecryptedVault{}, err
	}
	meta := npcore.VaultMetadata{
		Name:        strings.TrimSpace(name),
		Description: strings.TrimSpace(description),
	}
	encKey, err := npcore.EncryptBytesB64(rootKey, vkB64, npcore.AADVaultOwnerKey(id))
	if err != nil {
		return DecryptedVault{}, err
	}
	encMeta, err := npcore.EncryptJSON(vkB64, meta, npcore.AADVaultMeta(id))
	if err != nil {
		return DecryptedVault{}, err
	}

	var res struct {
		Vault EncryptedVaultRecord `json:"vault"`
	}
	if err := c.doJSON(ctx, http.MethodPost, "/api/vaults", map[string]any{
		"id":            id,
		"encryptedKey":  encKey,
		"encryptedMeta": encMeta,
	}, &res); err != nil {
		return DecryptedVault{}, err
	}

	created := DecryptedVault{
		ID:        id,
		Metadata:  meta,
		KeyB64:    vkB64,
		CreatedAt: res.Vault.CreatedAt,
		UpdatedAt: res.Vault.UpdatedAt,
	}
	c.mu.Lock()
	c.vaultKeys[id] = vkB64
	c.vaults = append(c.vaults, created)
	c.mu.Unlock()
	return created, nil
}

func (c *Client) SaveItem(ctx context.Context, item npcore.VaultItemPayload, isNew bool) (npcore.VaultItemPayload, error) {
	c.mu.RLock()
	vkB64 := c.vaultKeys[item.VaultID]
	c.mu.RUnlock()
	if vkB64 == "" {
		return npcore.VaultItemPayload{}, errors.New("未找到目标密码库密钥")
	}
	if item.ID == "" {
		id, err := npcore.RandomID()
		if err != nil {
			return npcore.VaultItemPayload{}, err
		}
		item.ID = id
		isNew = true
	}
	now := time.Now().UTC().Format("2006-01-02T15:04:05.000Z")
	if item.CreatedAt == "" {
		item.CreatedAt = now
	}
	item.UpdatedAt = now
	item.Normalize()

	encData, err := npcore.EncryptJSON(vkB64, item, npcore.AADVaultItem(item.VaultID, item.ID))
	if err != nil {
		return npcore.VaultItemPayload{}, err
	}

	if isNew {
		if err := c.doJSON(ctx, http.MethodPost, fmt.Sprintf("/api/vaults/%s/items", url.PathEscape(item.VaultID)), map[string]any{
			"id":            item.ID,
			"encryptedData": encData,
		}, nil); err != nil {
			return npcore.VaultItemPayload{}, err
		}
	} else {
		if err := c.doJSON(ctx, http.MethodPut, fmt.Sprintf("/api/vaults/%s/items/%s", url.PathEscape(item.VaultID), url.PathEscape(item.ID)), map[string]any{
			"encryptedData": encData,
		}, nil); err != nil {
			return npcore.VaultItemPayload{}, err
		}
	}

	c.mu.Lock()
	next := make([]npcore.VaultItemPayload, 0, len(c.items)+1)
	next = append(next, item)
	for _, existing := range c.items {
		if existing.ID != item.ID {
			next = append(next, existing)
		}
	}
	c.items = next
	c.mu.Unlock()
	return item, nil
}

func (c *Client) DeleteItem(ctx context.Context, vaultID, itemID string) error {
	path := fmt.Sprintf("/api/vaults/%s/items/%s", url.PathEscape(vaultID), url.PathEscape(itemID))
	if err := c.doJSON(ctx, http.MethodDelete, path, nil, nil); err != nil {
		return err
	}
	c.mu.Lock()
	filtered := make([]npcore.VaultItemPayload, 0, len(c.items))
	for _, it := range c.items {
		if it.ID != itemID {
			filtered = append(filtered, it)
		}
	}
	c.items = filtered
	c.mu.Unlock()
	return nil
}

func (c *Client) DeleteEmail(ctx context.Context, emailID string) error {
	if err := c.doJSON(ctx, http.MethodDelete, "/api/emails/"+url.PathEscape(emailID), nil, nil); err != nil {
		return err
	}
	c.mu.Lock()
	filtered := make([]DecryptedEmail, 0, len(c.emails))
	for _, em := range c.emails {
		if em.ID != emailID {
			filtered = append(filtered, em)
		}
	}
	c.emails = filtered
	c.mu.Unlock()
	return nil
}

func (c *Client) SimulateEmail(ctx context.Context, from, to, subject, text string) error {
	return c.doJSON(ctx, http.MethodPost, "/api/emails/simulate", map[string]any{
		"from":    from,
		"to":      to,
		"subject": subject,
		"text":    text,
	}, nil)
}

func (c *Client) Lock(ctx context.Context) {
	c.mu.Lock()
	wsCancel := c.wsCancel
	c.wsCancel = nil
	token := c.sessionToken
	c.mu.Unlock()

	if wsCancel != nil {
		wsCancel()
	}
	if token != "" {
		logoutCtx, cancel := context.WithTimeout(ctx, 2*time.Second)
		_ = c.doJSON(logoutCtx, http.MethodPost, "/api/auth/logout", nil, nil)
		cancel()
	}

	c.mu.Lock()
	c.sessionToken = ""
	c.rootKeyB64 = ""
	c.emailPrivKey = ""
	c.vaultKeys = make(map[string]string)
	c.vaults = nil
	c.items = nil
	c.aliases = nil
	c.emails = nil
	c.mu.Unlock()
}

func (c *Client) StartWebSocket() {
	c.mu.Lock()
	if c.wsCancel != nil {
		c.wsCancel()
		c.wsCancel = nil
	}
	if c.sessionToken == "" {
		c.mu.Unlock()
		return
	}
	ctx, cancel := context.WithCancel(context.Background())
	c.wsCancel = cancel
	c.mu.Unlock()

	go c.wsLoop(ctx)
}

func (c *Client) emit(ev PushEvent) {
	c.mu.RLock()
	fn := c.onPush
	c.mu.RUnlock()
	if fn != nil {
		fn(ev)
	}
}

func (c *Client) wsURL() (string, error) {
	c.mu.RLock()
	baseURL := c.serverURL
	token := c.sessionToken
	c.mu.RUnlock()
	if token == "" {
		return "", errors.New("missing session token")
	}
	parsed, err := url.Parse(baseURL)
	if err != nil {
		return "", err
	}
	switch parsed.Scheme {
	case "https":
		parsed.Scheme = "wss"
	default:
		parsed.Scheme = "ws"
	}
	parsed.Path = strings.TrimRight(parsed.Path, "/") + "/api/ws"
	q := parsed.Query()
	q.Set("token", token)
	parsed.RawQuery = q.Encode()
	return parsed.String(), nil
}

func (c *Client) wsLoop(ctx context.Context) {
	backoff := time.Second
	for {
		if ctx.Err() != nil {
			return
		}
		targetURL, err := c.wsURL()
		if err != nil {
			return
		}
		conn, _, err := websocket.Dial(ctx, targetURL, nil)
		if err != nil {
			connected := false
			c.emit(PushEvent{Type: "ws.status", WSConnected: &connected})
			select {
			case <-ctx.Done():
				return
			case <-time.After(backoff):
				if backoff < 10*time.Second {
					backoff *= 2
				}
				continue
			}
		}

		backoff = time.Second
		connected := true
		c.emit(PushEvent{Type: "ws.status", WSConnected: &connected})

		for {
			_, msgBytes, err := conn.Read(ctx)
			if err != nil {
				_ = conn.Close(websocket.StatusNormalClosure, "")
				disconnected := false
				c.emit(PushEvent{Type: "ws.status", WSConnected: &disconnected})
				break
			}
			c.handleWSMessage(ctx, msgBytes)
		}
	}
}

func (c *Client) handleWSMessage(ctx context.Context, msgBytes []byte) {
	var msg struct {
		Type  string                `json:"type"`
		Email *EncryptedEmailRecord `json:"email,omitempty"`
	}
	if err := json.Unmarshal(msgBytes, &msg); err != nil {
		return
	}

	switch msg.Type {
	case "email.received":
		if msg.Email == nil {
			return
		}
		opened, ok := c.decryptEmailRecord(*msg.Email)
		if !ok {
			return
		}
		c.mu.Lock()
		next := make([]DecryptedEmail, 0, len(c.emails)+1)
		next = append(next, opened)
		for _, existing := range c.emails {
			if existing.ID != opened.ID && len(next) < 100 {
				next = append(next, existing)
			}
		}
		c.emails = next
		snap := SyncSnapshot{
			Account: c.account,
			Vaults:  append([]DecryptedVault(nil), c.vaults...),
			Items:   append([]npcore.VaultItemPayload(nil), c.items...),
			Aliases: append([]AliasRecord(nil), c.aliases...),
			Emails:  append([]DecryptedEmail(nil), c.emails...),
		}
		c.mu.Unlock()
		c.emit(PushEvent{
			Type:     "email.received",
			Email:    &opened,
			Snapshot: &snap,
		})

	case "item.upserted", "item.deleted", "vault.upserted", "vault.deleted", "alias.upserted", "alias.deleted":
		syncCtx, cancel := context.WithTimeout(ctx, 10*time.Second)
		snap, err := c.Sync(syncCtx)
		cancel()
		if err == nil {
			c.emit(PushEvent{
				Type:     msg.Type,
				Snapshot: &snap,
			})
		}
	}
}
