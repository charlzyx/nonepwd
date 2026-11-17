package main

import (
	"context"
	"fmt"
	"strings"
	"time"

	"github.com/egoist/asuka/app"
	"github.com/egoist/asuka/signal"
	"github.com/egoist/asuka/ui"

	"desktop/client"
	"desktop/npcore"
)

type FilterSection string

const (
	SectionAll      FilterSection = "all"
	SectionFavorite FilterSection = "favorite"
	SectionLogin    FilterSection = "login"
	SectionCard     FilterSection = "card"
	SectionIdentity FilterSection = "identity"
	SectionDev      FilterSection = "dev"
	SectionEmails   FilterSection = "emails"
)

type EditorState struct {
	Active    bool
	IsNew     bool
	ID        string
	CreatedAt string

	VaultIdx    *signal.Signal[int]
	CategoryIdx *signal.Signal[int]
	Favorite    *signal.Signal[bool]
	Title       *signal.Signal[string]
	Username    *signal.Signal[string]
	Password    *signal.Signal[string]
	TOTP        *signal.Signal[string]
	EmailAlias  *signal.Signal[string]
	URLsText    *signal.Signal[string]
	Notes       *signal.Signal[string]

	// Card fields
	CardholderName *signal.Signal[string]
	CardNumber     *signal.Signal[string]
	CardBrand      *signal.Signal[string]
	CardExpMonth   *signal.Signal[string]
	CardExpYear    *signal.Signal[string]
	CardCVV        *signal.Signal[string]

	// Identity fields
	IDFullName   *signal.Signal[string]
	IDLastName   *signal.Signal[string]
	IDFirstName  *signal.Signal[string]
	IDEmail      *signal.Signal[string]
	IDPhone      *signal.Signal[string]
	IDCompany    *signal.Signal[string]
	IDAddress1   *signal.Signal[string]
	IDAddress2   *signal.Signal[string]
	IDCity       *signal.Signal[string]
	IDState      *signal.Signal[string]
	IDPostalCode *signal.Signal[string]
	IDCountry    *signal.Signal[string]

	Error *signal.Signal[string]
}

var categoryOrder = []npcore.ItemCategory{
	npcore.CategoryLogin,
	npcore.CategoryCard,
	npcore.CategoryIdentity,
	npcore.CategoryAPICredential,
	npcore.CategorySecureNote,
	npcore.CategorySSHKey,
}

var categoryLabels = []string{
	"网站登录",
	"银行卡",
	"身份地址",
	"API 密钥",
	"安全笔记",
	"SSH 密钥",
}

func CategoryLabel(cat npcore.ItemCategory) string {
	switch cat {
	case npcore.CategoryLogin:
		return "网站登录"
	case npcore.CategoryCard:
		return "银行卡"
	case npcore.CategoryIdentity:
		return "身份地址"
	case npcore.CategoryAPICredential:
		return "API 密钥"
	case npcore.CategorySecureNote:
		return "安全笔记"
	case npcore.CategorySSHKey:
		return "SSH 密钥"
	default:
		return string(cat)
	}
}

func CategoryIcon(cat npcore.ItemCategory) ui.Icon {
	switch cat {
	case npcore.CategoryLogin:
		return "globe"
	case npcore.CategoryCard:
		return "creditcard.fill"
	case npcore.CategoryIdentity:
		return "person.text.rectangle.fill"
	case npcore.CategoryAPICredential:
		return "key.fill"
	case npcore.CategorySecureNote:
		return "doc.text.fill"
	case npcore.CategorySSHKey:
		return "terminal.fill"
	default:
		return "lock.fill"
	}
}

type AppState struct {
	cfgStore *client.ConfigStore
	api      *client.Client

	// Auth / Unlock signals
	unlocked       *signal.Signal[bool]
	authMode       *signal.Signal[int] // 0 = 解锁现有密码库, 1 = 初始化新服务端
	serverURL      *signal.Signal[string]
	serverStatus   *signal.Signal[string]
	setupEmail     *signal.Signal[string]
	setupAliasDom  *signal.Signal[string]
	secretKey      *signal.Signal[string]
	masterPassword *signal.Signal[string]
	rememberDevice *signal.Signal[bool]
	busy           *signal.Signal[bool]
	authError      *signal.Signal[string]

	// Unlocked workspace signals
	wsConnected     *signal.Signal[bool]
	accountEmail    *signal.Signal[string]
	aliasDomain     *signal.Signal[string]
	vaults          *signal.Signal[[]client.DecryptedVault]
	items           *signal.Signal[[]npcore.VaultItemPayload]
	emails          *signal.Signal[[]client.DecryptedEmail]
	selectedVaultID *signal.Signal[string] // "all" or vault UUID
	section         *signal.Signal[FilterSection]
	searchQuery     *signal.Signal[string]
	selectedItemID  *signal.Signal[string]

	// Detail reveal & live TOTP signals
	revealSecret  *signal.Signal[bool]
	totpCode      *signal.Signal[string]
	totpRemaining *signal.Signal[int]
	totpProgress  *signal.Signal[float64]

	// Clipboard 30s auto-clear & status toast
	clipClearAt   time.Time
	clipRemaining *signal.Signal[int]
	statusBanner  *signal.Signal[string]

	// Editor state
	editing *signal.Signal[bool]
	editor  *EditorState
}

func NewAppState() *AppState {
	cfgDir, _ := app.ConfigDir()
	return NewAppStateWithConfigDir(cfgDir)
}

func NewAppStateWithConfigDir(cfgDir string) *AppState {
	store, _ := client.NewConfigStore(cfgDir)
	saved := client.SavedConfig{
		ServerURL:      client.DefaultServerURL,
		RememberDevice: true,
	}
	if store != nil {
		saved = store.Load()
	}

	c := client.New(saved.ServerURL)
	s := &AppState{
		cfgStore:       store,
		api:            c,
		unlocked:       signal.New(false),
		authMode:       signal.New(0),
		serverURL:      signal.New(saved.ServerURL),
		serverStatus:   signal.New(""),
		setupEmail:     signal.New(saved.Email),
		setupAliasDom:  signal.New(""),
		secretKey:      signal.New(saved.SecretKey),
		masterPassword: signal.New(""),
		rememberDevice: signal.New(saved.RememberDevice),
		busy:           signal.New(false),
		authError:      signal.New(""),

		wsConnected:     signal.New(false),
		accountEmail:    signal.New(saved.Email),
		aliasDomain:     signal.New(""),
		vaults:          signal.NewFunc([]client.DecryptedVault(nil), func(_, _ []client.DecryptedVault) bool { return false }),
		items:           signal.NewFunc([]npcore.VaultItemPayload(nil), func(_, _ []npcore.VaultItemPayload) bool { return false }),
		emails:          signal.NewFunc([]client.DecryptedEmail(nil), func(_, _ []client.DecryptedEmail) bool { return false }),
		selectedVaultID: signal.New("all"),
		section:         signal.New(SectionAll),
		searchQuery:     signal.New(""),
		selectedItemID:  signal.New(""),

		revealSecret:  signal.New(false),
		totpCode:      signal.New(""),
		totpRemaining: signal.New(0),
		totpProgress:  signal.New(0.0),

		clipRemaining: signal.New(0),
		statusBanner:  signal.New(""),

		editing: signal.New(false),
		editor:  newEditorState(),
	}

	c.SetOnPush(func(ev client.PushEvent) {
		ui.Post(func() {
			s.handlePushEvent(ev)
		})
	})

	return s
}

func newEditorState() *EditorState {
	return &EditorState{
		VaultIdx:       signal.New(0),
		CategoryIdx:    signal.New(0),
		Favorite:       signal.New(false),
		Title:          signal.New(""),
		Username:       signal.New(""),
		Password:       signal.New(""),
		TOTP:           signal.New(""),
		EmailAlias:     signal.New(""),
		URLsText:       signal.New(""),
		Notes:          signal.New(""),
		CardholderName: signal.New(""),
		CardNumber:     signal.New(""),
		CardBrand:      signal.New(""),
		CardExpMonth:   signal.New(""),
		CardExpYear:    signal.New(""),
		CardCVV:        signal.New(""),
		IDFullName:     signal.New(""),
		IDLastName:     signal.New(""),
		IDFirstName:    signal.New(""),
		IDEmail:        signal.New(""),
		IDPhone:        signal.New(""),
		IDCompany:      signal.New(""),
		IDAddress1:     signal.New(""),
		IDAddress2:     signal.New(""),
		IDCity:         signal.New(""),
		IDState:        signal.New(""),
		IDPostalCode:   signal.New(""),
		IDCountry:      signal.New(""),
		Error:          signal.New(""),
	}
}

func (s *AppState) StartBackgroundTickers() {
	stopCh := make(chan struct{})
	signal.OnCleanup(func() {
		close(stopCh)
	})
	go func() {
		ticker := time.NewTicker(time.Second)
		defer ticker.Stop()
		for {
			select {
			case <-stopCh:
				return
			case <-ticker.C:
				ui.Post(func() {
					s.onSecondTick()
				})
			}
		}
	}()

	// Probe initial server status asynchronously on startup.
	s.ProbeServer()
}

func (s *AppState) onSecondTick() {
	// 1. Update clipboard 30s auto-clear countdown.
	if s.clipRemaining.Peek() > 0 {
		rem := int(time.Until(s.clipClearAt).Round(time.Second).Seconds())
		if rem <= 0 {
			ui.Copy("")
			s.clipRemaining.Set(0)
			s.statusBanner.Set("剪贴板敏感内容已自动安全清空")
		} else {
			s.clipRemaining.Set(rem)
		}
	}

	// 2. Refresh live TOTP code for currently selected item.
	if s.unlocked.Peek() {
		s.refreshActiveTOTP()
	}
}

func (s *AppState) refreshActiveTOTP() {
	it := s.ActiveItemPeek()
	if it == nil || strings.TrimSpace(it.TOTP) == "" {
		if s.totpCode.Peek() != "" {
			s.totpCode.Set("")
			s.totpRemaining.Set(0)
			s.totpProgress.Set(0)
		}
		return
	}
	res, err := npcore.GenerateTOTP(it.TOTP, time.Now())
	if err != nil {
		s.totpCode.Set("格式无效")
		s.totpRemaining.Set(0)
		s.totpProgress.Set(0)
		return
	}
	s.totpCode.Set(FormatTOTPCode(res.Code))
	s.totpRemaining.Set(int(res.RemainingSeconds))
	s.totpProgress.Set(res.Progress)
}

func FormatTOTPCode(code string) string {
	if len(code) == 6 {
		return code[:3] + " " + code[3:]
	}
	if len(code) == 8 {
		return code[:4] + " " + code[4:]
	}
	return code
}

func (s *AppState) CopyWithAutoClear(label, value string) {
	if value == "" {
		return
	}
	ui.Copy(value)
	s.clipClearAt = time.Now().Add(30 * time.Second)
	s.clipRemaining.Set(30)
	s.statusBanner.Set(fmt.Sprintf("已复制%s", label))
}

func (s *AppState) ClearClipboardNow() {
	ui.Copy("")
	s.clipRemaining.Set(0)
	s.statusBanner.Set("已立即清空剪贴板")
}

func (s *AppState) ProbeServer() {
	srv := client.NormalizeServerURL(s.serverURL.Peek())
	s.api.SetServerURL(srv)
	s.serverStatus.Set("正在连接服务端...")
	go func() {
		ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
		defer cancel()
		params, err := s.api.CheckAuthParams(ctx)
		ui.Post(func() {
			if err != nil {
				s.serverStatus.Set("无法连接服务端: " + err.Error())
				return
			}
			if !params.Initialized {
				s.serverStatus.Set("服务端已连接 · 尚未初始化（可直接创建新密码库）")
				s.authMode.Set(1)
			} else {
				if params.Email != "" {
					s.serverStatus.Set("服务端就绪 · 账号 " + params.Email)
					if s.setupEmail.Peek() == "" {
						s.setupEmail.Set(params.Email)
					}
				} else {
					s.serverStatus.Set("服务端就绪 · 已初始化")
				}
				s.authMode.Set(0)
			}
		})
	}()
}

func (s *AppState) DoUnlockOrSetup() {
	if s.busy.Peek() {
		return
	}
	mode := s.authMode.Peek()
	srvURL := client.NormalizeServerURL(s.serverURL.Peek())
	sk := strings.TrimSpace(s.secretKey.Peek())
	mp := s.masterPassword.Peek()
	remember := s.rememberDevice.Peek()
	email := strings.TrimSpace(s.setupEmail.Peek())
	aliasDom := strings.TrimSpace(s.setupAliasDom.Peek())

	s.serverURL.Set(srvURL)
	s.api.SetServerURL(srvURL)
	s.authError.Set("")
	s.busy.Set(true)

	go func() {
		ctx, cancel := context.WithTimeout(context.Background(), 30*time.Second)
		defer cancel()

		var snap client.SyncSnapshot
		var err error
		usedSecretKey := sk
		if mode == 1 {
			if usedSecretKey == "" {
				usedSecretKey, err = npcore.GenerateSecretKey()
			}
			if err == nil {
				snap, err = s.api.SetupAccount(ctx, client.SetupParams{
					Email:          email,
					MasterPassword: mp,
					SecretKey:      usedSecretKey,
					AliasDomain:    aliasDom,
				})
			}
		} else {
			snap, err = s.api.Unlock(ctx, usedSecretKey, mp)
		}

		ui.Post(func() {
			s.busy.Set(false)
			if err != nil {
				s.authError.Set(err.Error())
				return
			}
			// Never keep master password in signal or disk.
			s.masterPassword.Set("")
			s.secretKey.Set(usedSecretKey)

			if s.cfgStore != nil {
				_ = s.cfgStore.Save(client.SavedConfig{
					ServerURL:      srvURL,
					Email:          snap.Account.Email,
					SecretKey:      usedSecretKey,
					RememberDevice: remember,
				})
			}

			s.applySnapshot(snap)
			s.unlocked.Set(true)
			s.api.StartWebSocket()
			s.refreshActiveTOTP()
		})
	}()
}

func (s *AppState) ForgetSavedSecretKey() {
	if s.cfgStore != nil {
		_ = s.cfgStore.ClearSecretKey()
	}
	s.secretKey.Set("")
	s.rememberDevice.Set(false)
	s.statusBanner.Set("已清除本地保存的 Secret Key")
}

func (s *AppState) applySnapshot(snap client.SyncSnapshot) {
	s.accountEmail.Set(snap.Account.Email)
	s.aliasDomain.Set(snap.Account.AliasDomain)
	s.vaults.Set(snap.Vaults)
	s.items.Set(snap.Items)
	s.emails.Set(snap.Emails)

	curID := s.selectedItemID.Peek()
	found := false
	for _, it := range snap.Items {
		if it.ID == curID {
			found = true
			break
		}
	}
	if !found {
		if len(snap.Items) > 0 {
			s.selectedItemID.Set(snap.Items[0].ID)
		} else {
			s.selectedItemID.Set("")
		}
	}
}

func (s *AppState) handlePushEvent(ev client.PushEvent) {
	if ev.WSConnected != nil {
		s.wsConnected.Set(*ev.WSConnected)
	}
	if ev.Snapshot != nil {
		s.applySnapshot(*ev.Snapshot)
		s.refreshActiveTOTP()
	}
	if ev.Type == "email.received" && ev.Email != nil {
		em := ev.Email
		if em.OTPCode != "" {
			code := em.OTPCode
			domain := em.SenderDomain
			if domain == "" {
				domain = em.From
			}
			s.statusBanner.Set(fmt.Sprintf("收到新邮箱验证码: %s (%s)", code, domain))
			ui.Snackbar(ui.SnackbarProps{
				Message: fmt.Sprintf("新验证码 %s · %s", code, domain),
				Action: &ui.Action{
					Title: ui.Val("复制"),
					OnPress: func() {
						s.CopyWithAutoClear("邮箱验证码", code)
					},
				},
			})
		} else {
			s.statusBanner.Set("收到新加密邮件: " + em.Subject)
		}
	}
}

func (s *AppState) RefreshSync() {
	if !s.unlocked.Peek() {
		return
	}
	s.statusBanner.Set("正在同步密文库...")
	go func() {
		ctx, cancel := context.WithTimeout(context.Background(), 15*time.Second)
		defer cancel()
		snap, err := s.api.Sync(ctx)
		ui.Post(func() {
			if err != nil {
				s.statusBanner.Set("同步失败: " + err.Error())
				return
			}
			s.applySnapshot(snap)
			s.refreshActiveTOTP()
			s.statusBanner.Set("密码库已同步至最新状态")
		})
	}()
}

func (s *AppState) LockVault() {
	s.editing.Set(false)
	s.revealSecret.Set(false)
	s.masterPassword.Set("")
	s.totpCode.Set("")
	s.totpRemaining.Set(0)
	s.totpProgress.Set(0)
	s.wsConnected.Set(false)
	s.vaults.Set(nil)
	s.items.Set(nil)
	s.emails.Set(nil)
	s.selectedItemID.Set("")
	s.unlocked.Set(false)

	if !s.rememberDevice.Peek() {
		s.secretKey.Set("")
	}

	go func() {
		s.api.Lock(context.Background())
	}()
}

func (s *AppState) FilteredItems(items []npcore.VaultItemPayload, vaultID string, sec FilterSection, query string) []npcore.VaultItemPayload {
	q := strings.ToLower(strings.TrimSpace(query))
	out := make([]npcore.VaultItemPayload, 0, len(items))
	for _, it := range items {
		if vaultID != "all" && it.VaultID != vaultID {
			continue
		}
		switch sec {
		case SectionFavorite:
			if !it.Favorite {
				continue
			}
		case SectionLogin:
			if it.Category != npcore.CategoryLogin {
				continue
			}
		case SectionCard:
			if it.Category != npcore.CategoryCard && it.Card == nil {
				continue
			}
		case SectionIdentity:
			if it.Category != npcore.CategoryIdentity && it.Identity == nil {
				continue
			}
		case SectionDev:
			if it.Category != npcore.CategoryAPICredential && it.Category != npcore.CategorySecureNote && it.Category != npcore.CategorySSHKey {
				continue
			}
		}
		if q != "" && !itemMatchesQuery(it, q) {
			continue
		}
		out = append(out, it)
	}
	return out
}

func itemMatchesQuery(it npcore.VaultItemPayload, q string) bool {
	if strings.Contains(strings.ToLower(it.Title), q) ||
		strings.Contains(strings.ToLower(it.Username), q) ||
		strings.Contains(strings.ToLower(it.EmailAlias), q) ||
		strings.Contains(strings.ToLower(it.Notes), q) {
		return true
	}
	for _, u := range it.URLs {
		if strings.Contains(strings.ToLower(u), q) {
			return true
		}
	}
	for _, tag := range it.Tags {
		if strings.Contains(strings.ToLower(tag), q) {
			return true
		}
	}
	if it.Card != nil {
		if strings.Contains(strings.ToLower(it.Card.CardholderName), q) ||
			strings.Contains(strings.ToLower(it.Card.Brand), q) ||
			strings.Contains(strings.ToLower(it.Card.Number), q) {
			return true
		}
	}
	if it.Identity != nil {
		if strings.Contains(strings.ToLower(it.Identity.FullName), q) ||
			strings.Contains(strings.ToLower(it.Identity.Email), q) ||
			strings.Contains(strings.ToLower(it.Identity.Phone), q) ||
			strings.Contains(strings.ToLower(it.Identity.Address1), q) ||
			strings.Contains(strings.ToLower(it.Identity.City), q) {
			return true
		}
	}
	return false
}

func (s *AppState) SelectItem(id string) {
	s.editing.Set(false)
	s.revealSecret.Set(false)
	s.selectedItemID.Set(id)
	s.refreshActiveTOTP()
}

func (s *AppState) ActiveItemGet() *npcore.VaultItemPayload {
	items := s.items.Get()
	filtered := s.FilteredItems(items, s.selectedVaultID.Get(), s.section.Get(), s.searchQuery.Get())
	selID := s.selectedItemID.Get()
	for i := range filtered {
		if filtered[i].ID == selID {
			cp := filtered[i]
			return &cp
		}
	}
	for i := range items {
		if items[i].ID == selID {
			cp := items[i]
			return &cp
		}
	}
	if len(filtered) > 0 {
		cp := filtered[0]
		return &cp
	}
	return nil
}

func (s *AppState) ActiveItemPeek() *npcore.VaultItemPayload {
	items := s.items.Peek()
	filtered := s.FilteredItems(items, s.selectedVaultID.Peek(), s.section.Peek(), s.searchQuery.Peek())
	selID := s.selectedItemID.Peek()
	for i := range filtered {
		if filtered[i].ID == selID {
			cp := filtered[i]
			return &cp
		}
	}
	for i := range items {
		if items[i].ID == selID {
			cp := items[i]
			return &cp
		}
	}
	if len(filtered) > 0 {
		cp := filtered[0]
		return &cp
	}
	return nil
}

func (s *AppState) VaultName(vaultID string) string {
	for _, v := range s.vaults.Get() {
		if v.ID == vaultID {
			return v.Metadata.Name
		}
	}
	return "默认密码库"
}

func (s *AppState) MatchedEmailOTP(it *npcore.VaultItemPayload) *client.DecryptedEmail {
	if it == nil {
		return nil
	}
	emails := s.emails.Get()
	cutoff := time.Now().Add(-15 * time.Minute)
	for i := range emails {
		em := &emails[i]
		if em.OTPCode == "" {
			continue
		}
		if ts, err := time.Parse(time.RFC3339, em.ReceivedAt); err == nil {
			if ts.Before(cutoff) {
				continue
			}
		}
		if it.EmailAlias != "" && strings.EqualFold(em.To, it.EmailAlias) {
			cp := *em
			return &cp
		}
		domain := em.SenderDomain
		if domain == "" {
			domain = em.From
		}
		for _, u := range it.URLs {
			if npcore.DomainsMatch(u, domain) {
				cp := *em
				return &cp
			}
		}
	}
	return nil
}

func (s *AppState) OpenCreateEditor() {
	vaults := s.vaults.Peek()
	if len(vaults) == 0 {
		s.statusBanner.Set("尚未加载到可用密码库")
		return
	}
	vIdx := 0
	selVault := s.selectedVaultID.Peek()
	for i, v := range vaults {
		if v.ID == selVault {
			vIdx = i
			break
		}
	}
	catIdx := 0
	switch s.section.Peek() {
	case SectionCard:
		catIdx = 1
	case SectionIdentity:
		catIdx = 2
	case SectionDev:
		catIdx = 3
	}

	e := s.editor
	e.Active = true
	e.IsNew = true
	e.ID = ""
	e.CreatedAt = ""
	e.VaultIdx.Set(vIdx)
	e.CategoryIdx.Set(catIdx)
	e.Favorite.Set(false)
	e.Title.Set("")
	e.Username.Set("")
	e.Password.Set("")
	e.TOTP.Set("")
	e.EmailAlias.Set("")
	e.URLsText.Set("")
	e.Notes.Set("")
	e.CardholderName.Set("")
	e.CardNumber.Set("")
	e.CardBrand.Set("")
	e.CardExpMonth.Set("")
	e.CardExpYear.Set("")
	e.CardCVV.Set("")
	e.IDFullName.Set("")
	e.IDLastName.Set("")
	e.IDFirstName.Set("")
	e.IDEmail.Set("")
	e.IDPhone.Set("")
	e.IDCompany.Set("")
	e.IDAddress1.Set("")
	e.IDAddress2.Set("")
	e.IDCity.Set("")
	e.IDState.Set("")
	e.IDPostalCode.Set("")
	e.IDCountry.Set("")
	e.Error.Set("")

	if s.section.Peek() == SectionEmails {
		s.section.Set(SectionAll)
	}
	s.editing.Set(true)
}

func (s *AppState) OpenEditEditor(it npcore.VaultItemPayload) {
	vaults := s.vaults.Peek()
	vIdx := 0
	for i, v := range vaults {
		if v.ID == it.VaultID {
			vIdx = i
			break
		}
	}
	catIdx := 0
	for i, c := range categoryOrder {
		if c == it.Category {
			catIdx = i
			break
		}
	}

	e := s.editor
	e.Active = true
	e.IsNew = false
	e.ID = it.ID
	e.CreatedAt = it.CreatedAt
	e.VaultIdx.Set(vIdx)
	e.CategoryIdx.Set(catIdx)
	e.Favorite.Set(it.Favorite)
	e.Title.Set(it.Title)
	e.Username.Set(it.Username)
	e.Password.Set(it.Password)
	e.TOTP.Set(it.TOTP)
	e.EmailAlias.Set(it.EmailAlias)
	e.URLsText.Set(strings.Join(it.URLs, "\n"))
	e.Notes.Set(it.Notes)

	if it.Card != nil {
		e.CardholderName.Set(it.Card.CardholderName)
		e.CardNumber.Set(it.Card.Number)
		e.CardBrand.Set(it.Card.Brand)
		e.CardExpMonth.Set(it.Card.ExpMonth)
		e.CardExpYear.Set(it.Card.ExpYear)
		e.CardCVV.Set(it.Card.CVV)
	} else {
		e.CardholderName.Set("")
		e.CardNumber.Set("")
		e.CardBrand.Set("")
		e.CardExpMonth.Set("")
		e.CardExpYear.Set("")
		e.CardCVV.Set("")
	}

	if it.Identity != nil {
		e.IDFullName.Set(it.Identity.FullName)
		e.IDLastName.Set(it.Identity.LastName)
		e.IDFirstName.Set(it.Identity.FirstName)
		e.IDEmail.Set(it.Identity.Email)
		e.IDPhone.Set(it.Identity.Phone)
		e.IDCompany.Set(it.Identity.Company)
		e.IDAddress1.Set(it.Identity.Address1)
		e.IDAddress2.Set(it.Identity.Address2)
		e.IDCity.Set(it.Identity.City)
		e.IDState.Set(it.Identity.State)
		e.IDPostalCode.Set(it.Identity.PostalCode)
		e.IDCountry.Set(it.Identity.Country)
	} else {
		e.IDFullName.Set("")
		e.IDLastName.Set("")
		e.IDFirstName.Set("")
		e.IDEmail.Set("")
		e.IDPhone.Set("")
		e.IDCompany.Set("")
		e.IDAddress1.Set("")
		e.IDAddress2.Set("")
		e.IDCity.Set("")
		e.IDState.Set("")
		e.IDPostalCode.Set("")
		e.IDCountry.Set("")
	}
	e.Error.Set("")
	s.editing.Set(true)
}

func (s *AppState) SaveEditorItem() {
	if s.busy.Peek() {
		return
	}
	e := s.editor
	title := strings.TrimSpace(e.Title.Peek())
	if title == "" {
		e.Error.Set("请输入条目标题")
		return
	}
	vaults := s.vaults.Peek()
	vIdx := e.VaultIdx.Peek()
	if vIdx < 0 || vIdx >= len(vaults) {
		e.Error.Set("请选择所属密码库")
		return
	}
	catIdx := e.CategoryIdx.Peek()
	if catIdx < 0 || catIdx >= len(categoryOrder) {
		catIdx = 0
	}

	var urls []string
	for _, line := range strings.Split(e.URLsText.Peek(), "\n") {
		if u := strings.TrimSpace(line); u != "" {
			urls = append(urls, u)
		}
	}

	card := &npcore.CardDetails{
		CardholderName: strings.TrimSpace(e.CardholderName.Peek()),
		Number:         strings.ReplaceAll(strings.TrimSpace(e.CardNumber.Peek()), " ", ""),
		Brand:          strings.TrimSpace(e.CardBrand.Peek()),
		ExpMonth:       strings.TrimSpace(e.CardExpMonth.Peek()),
		ExpYear:        strings.TrimSpace(e.CardExpYear.Peek()),
		CVV:            strings.TrimSpace(e.CardCVV.Peek()),
	}
	if card.IsEmpty() {
		card = nil
	}

	ident := &npcore.IdentityDetails{
		FullName:   strings.TrimSpace(e.IDFullName.Peek()),
		LastName:   strings.TrimSpace(e.IDLastName.Peek()),
		FirstName:  strings.TrimSpace(e.IDFirstName.Peek()),
		Email:      strings.TrimSpace(e.IDEmail.Peek()),
		Phone:      strings.TrimSpace(e.IDPhone.Peek()),
		Company:    strings.TrimSpace(e.IDCompany.Peek()),
		Address1:   strings.TrimSpace(e.IDAddress1.Peek()),
		Address2:   strings.TrimSpace(e.IDAddress2.Peek()),
		City:       strings.TrimSpace(e.IDCity.Peek()),
		State:      strings.TrimSpace(e.IDState.Peek()),
		PostalCode: strings.TrimSpace(e.IDPostalCode.Peek()),
		Country:    strings.TrimSpace(e.IDCountry.Peek()),
	}
	if ident.IsEmpty() {
		ident = nil
	}

	// Preserve existing tags/customFields when editing.
	var existingTags []string
	var existingFields []npcore.CustomField
	if !e.IsNew {
		for _, prev := range s.items.Peek() {
			if prev.ID == e.ID {
				existingTags = prev.Tags
				existingFields = prev.CustomFields
				break
			}
		}
	}

	payload := npcore.VaultItemPayload{
		ID:           e.ID,
		VaultID:      vaults[vIdx].ID,
		Category:     categoryOrder[catIdx],
		Title:        title,
		Favorite:     e.Favorite.Peek(),
		Tags:         existingTags,
		URLs:         urls,
		Username:     strings.TrimSpace(e.Username.Peek()),
		Password:     e.Password.Peek(),
		TOTP:         strings.TrimSpace(e.TOTP.Peek()),
		EmailAlias:   strings.TrimSpace(e.EmailAlias.Peek()),
		Notes:        strings.TrimSpace(e.Notes.Peek()),
		Card:         card,
		Identity:     ident,
		CustomFields: existingFields,
		CreatedAt:    e.CreatedAt,
	}
	isNew := e.IsNew

	e.Error.Set("")
	s.busy.Set(true)
	go func() {
		ctx, cancel := context.WithTimeout(context.Background(), 15*time.Second)
		defer cancel()
		saved, err := s.api.SaveItem(ctx, payload, isNew)
		snap := s.api.Snapshot()
		ui.Post(func() {
			s.busy.Set(false)
			if err != nil {
				e.Error.Set(err.Error())
				return
			}
			s.applySnapshot(snap)
			s.editing.Set(false)
			s.selectedItemID.Set(saved.ID)
			s.refreshActiveTOTP()
			s.statusBanner.Set("已加密保存条目: " + saved.Title)
		})
	}()
}

func (s *AppState) ToggleFavorite(it npcore.VaultItemPayload) {
	it.Favorite = !it.Favorite
	go func() {
		ctx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
		defer cancel()
		_, err := s.api.SaveItem(ctx, it, false)
		snap := s.api.Snapshot()
		ui.Post(func() {
			if err != nil {
				s.statusBanner.Set("更新收藏失败: " + err.Error())
				return
			}
			s.applySnapshot(snap)
		})
	}()
}

func (s *AppState) ConfirmDeleteItem(it npcore.VaultItemPayload) {
	ui.Alert(ui.AlertProps{
		Title:   "确认删除凭据",
		Message: fmt.Sprintf("确定要永久删除「%s」吗？该操作不可撤销。", it.Title),
		Actions: []ui.Action{
			{Title: ui.Val("取消"), Role: ui.ActionCancel},
			{
				Title: ui.Val("删除"),
				Role:  ui.ActionDestructive,
				OnPress: func() {
					go func() {
						ctx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
						defer cancel()
						err := s.api.DeleteItem(ctx, it.VaultID, it.ID)
						snap := s.api.Snapshot()
						ui.Post(func() {
							if err != nil {
								s.statusBanner.Set("删除失败: " + err.Error())
								return
							}
							s.applySnapshot(snap)
							s.refreshActiveTOTP()
							s.statusBanner.Set("已删除条目: " + it.Title)
						})
					}()
				},
			},
		},
	})
}

func (s *AppState) PromptCreateVault() {
	nameSig := signal.New("")
	descSig := signal.New("")
	ui.Alert(ui.AlertProps{
		Title:   "新建加密密码库",
		Message: "每个密码库拥有独立的 256-bit AES-GCM 密钥，由根密钥端到端加密保护。",
		Fields: []ui.AlertField{
			{Text: nameSig, Placeholder: "密码库名称（例如 Work / 家庭）"},
			{Text: descSig, Placeholder: "备注说明（可选）"},
		},
		Actions: []ui.Action{
			{Title: ui.Val("取消"), Role: ui.ActionCancel},
			{
				Title: ui.Val("创建"),
				Role:  ui.ActionDefault,
				Disabled: signal.Func(func() bool {
					return strings.TrimSpace(nameSig.Get()) == ""
				}),
				OnPress: func() {
					name := strings.TrimSpace(nameSig.Peek())
					desc := strings.TrimSpace(descSig.Peek())
					if name == "" {
						return
					}
					go func() {
						ctx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
						defer cancel()
						created, err := s.api.CreateVault(ctx, name, desc)
						snap := s.api.Snapshot()
						ui.Post(func() {
							if err != nil {
								s.statusBanner.Set("创建密码库失败: " + err.Error())
								return
							}
							s.applySnapshot(snap)
							s.selectedVaultID.Set(created.ID)
							s.statusBanner.Set("已创建密码库: " + created.Metadata.Name)
						})
					}()
				},
			},
		},
	})
}

func MaskCardNumber(num string) string {
	clean := strings.ReplaceAll(strings.TrimSpace(num), " ", "")
	if len(clean) <= 4 {
		return clean
	}
	return "•••• •••• •••• " + clean[len(clean)-4:]
}

func FormatCardNumberSpaced(num string) string {
	clean := strings.ReplaceAll(strings.TrimSpace(num), " ", "")
	var parts []string
	for i := 0; i < len(clean); i += 4 {
		end := i + 4
		if end > len(clean) {
			end = len(clean)
		}
		parts = append(parts, clean[i:end])
	}
	return strings.Join(parts, " ")
}

func FormatFullAddress(id *npcore.IdentityDetails) string {
	if id == nil {
		return ""
	}
	var parts []string
	for _, p := range []string{id.Country, id.State, id.City, id.Address1, id.Address2, id.PostalCode} {
		if t := strings.TrimSpace(p); t != "" {
			parts = append(parts, t)
		}
	}
	return strings.Join(parts, " ")
}

func ItemSubtitle(it npcore.VaultItemPayload) string {
	switch it.Category {
	case npcore.CategoryCard:
		if it.Card != nil {
			brand := it.Card.Brand
			if brand == "" {
				brand = "银行卡"
			}
			if it.Card.Number != "" {
				return brand + " · " + MaskCardNumber(it.Card.Number)
			}
			if it.Card.CardholderName != "" {
				return brand + " · " + it.Card.CardholderName
			}
		}
	case npcore.CategoryIdentity:
		if it.Identity != nil {
			name := it.Identity.FullName
			if name == "" {
				name = strings.TrimSpace(it.Identity.LastName + it.Identity.FirstName)
			}
			if name != "" && it.Identity.Phone != "" {
				return name + " · " + it.Identity.Phone
			}
			if name != "" {
				return name
			}
			if it.Identity.Email != "" {
				return it.Identity.Email
			}
		}
	}
	if it.Username != "" {
		return it.Username
	}
	if len(it.URLs) > 0 {
		return it.URLs[0]
	}
	return CategoryLabel(it.Category)
}
