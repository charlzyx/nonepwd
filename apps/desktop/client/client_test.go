package client

import (
	"bufio"
	"context"
	"fmt"
	"os"
	"os/exec"
	"path/filepath"
	"regexp"
	"strings"
	"testing"
	"time"

	"desktop/npcore"
)

var listenPortRe = regexp.MustCompile(`https?://(?:127\.0\.0\.1|0\.0\.0\.0|localhost):(\d+)`)

func startTestServer(t *testing.T) string {
	t.Helper()

	wd, err := os.Getwd()
	if err != nil {
		t.Fatalf("Getwd: %v", err)
	}
	repoRoot := filepath.Clean(filepath.Join(wd, "..", "..", ".."))
	dataDir := t.TempDir()

	var cmd *exec.Cmd
	npBin := filepath.Join(repoRoot, "dist", "bin", "np")
	useNP := false
	if st, err := os.Stat(npBin); err == nil && !st.IsDir() {
		if helpOut, err := exec.Command(npBin, "--help").CombinedOutput(); err == nil && strings.Contains(string(helpOut), "server") {
			useNP = true
		}
	}

	ctx, cancel := context.WithCancel(context.Background())
	if useNP {
		t.Logf("Starting Rust test server: %s server --host 127.0.0.1 --port 0 --data-dir %s", npBin, dataDir)
		cmd = exec.CommandContext(ctx, npBin, "server", "--host", "127.0.0.1", "--port", "0", "--data-dir", dataDir)
	} else {
		nodeIndex := filepath.Join(repoRoot, "packages", "server", "dist", "index.js")
		t.Logf("Starting Node test server: node %s (dataDir=%s)", nodeIndex, dataDir)
		cmd = exec.CommandContext(ctx, "node", nodeIndex)
		cmd.Env = append(os.Environ(),
			"NONEPWD_HOST=127.0.0.1",
			"NONEPWD_PORT=0",
			"NONEPWD_DATA_DIR="+dataDir,
		)
	}

	stdout, err := cmd.StdoutPipe()
	if err != nil {
		cancel()
		t.Fatalf("StdoutPipe: %v", err)
	}
	cmd.Stderr = cmd.Stdout

	if err := cmd.Start(); err != nil {
		cancel()
		t.Fatalf("start test server: %v", err)
	}
	t.Cleanup(func() {
		cancel()
		_ = cmd.Wait()
	})

	urlCh := make(chan string, 1)
	errCh := make(chan error, 1)
	go func() {
		scanner := bufio.NewScanner(stdout)
		var lines []string
		for scanner.Scan() {
			line := scanner.Text()
			lines = append(lines, line)
			if m := listenPortRe.FindStringSubmatch(line); len(m) == 2 {
				urlCh <- "http://127.0.0.1:" + m[1]
				// Drain remaining output so pipe never blocks.
				for scanner.Scan() {
				}
				return
			}
		}
		errCh <- fmt.Errorf("server exited without printing listen URL; output:\n%s", strings.Join(lines, "\n"))
	}()

	select {
	case srvURL := <-urlCh:
		return srvURL
	case err := <-errCh:
		t.Fatalf("test server failed: %v", err)
	case <-time.After(15 * time.Second):
		t.Fatalf("timed out waiting for test server to listen")
	}
	return ""
}

func TestConfigStoreNeverPersistsPassword(t *testing.T) {
	dir := t.TempDir()
	store, err := NewConfigStore(dir)
	if err != nil {
		t.Fatalf("NewConfigStore: %v", err)
	}
	if err := store.Save(SavedConfig{
		ServerURL:      "http://127.0.0.1:8787/",
		Email:          "alice@example.com",
		SecretKey:      "NP3-AAAA-BBBB-CCCC",
		RememberDevice: true,
	}); err != nil {
		t.Fatalf("Save: %v", err)
	}
	raw, err := os.ReadFile(store.Path())
	if err != nil {
		t.Fatalf("ReadFile: %v", err)
	}
	if strings.Contains(string(raw), "masterPassword") {
		t.Fatalf("config file must never contain masterPassword: %s", string(raw))
	}
	loaded := store.Load()
	if loaded.ServerURL != "http://127.0.0.1:8787" || loaded.SecretKey != "NP3-AAAA-BBBB-CCCC" {
		t.Fatalf("unexpected loaded config: %+v", loaded)
	}
}

func TestEndToEndZeroKnowledgeFlowAndWebSocketOTP(t *testing.T) {
	srvURL := startTestServer(t)
	ctx, cancel := context.WithTimeout(context.Background(), 30*time.Second)
	defer cancel()

	c1 := New(srvURL)
	params, err := c1.CheckAuthParams(ctx)
	if err != nil {
		t.Fatalf("CheckAuthParams: %v", err)
	}
	if params.Initialized {
		t.Fatalf("expected fresh test server to be uninitialized")
	}

	secretKey, err := npcore.GenerateSecretKey()
	if err != nil {
		t.Fatalf("GenerateSecretKey: %v", err)
	}
	masterPassword := "Correct-Horse-Battery-Staple-99!"

	snap, err := c1.SetupAccount(ctx, SetupParams{
		Email:          "tester@nonepwd.local",
		MasterPassword: masterPassword,
		SecretKey:      secretKey,
		AliasDomain:    "mail.nonepwd.local",
		KDFIterations:  20_000, // faster PBKDF2 in unit test while exercising full core derive_account_keys
	})
	if err != nil {
		t.Fatalf("SetupAccount: %v", err)
	}
	if len(snap.Vaults) < 2 {
		t.Fatalf("expected default vaults, got %d", len(snap.Vaults))
	}
	personalVaultID := snap.Vaults[0].ID

	// Lock & unlock from a brand-new client instance to verify full login + root keyset decrypt + sync.
	c1.Lock(ctx)
	if c1.Unlocked() {
		t.Fatalf("expected c1 to be locked")
	}

	c2 := New(srvURL)
	wsOTPCh := make(chan DecryptedEmail, 4)
	wsConnectedCh := make(chan bool, 4)
	c2.SetOnPush(func(ev PushEvent) {
		if ev.WSConnected != nil && *ev.WSConnected {
			select {
			case wsConnectedCh <- true:
			default:
			}
		}
		if ev.Type == "email.received" && ev.Email != nil {
			wsOTPCh <- *ev.Email
		}
	})

	snap2, err := c2.Unlock(ctx, secretKey, masterPassword)
	if err != nil {
		t.Fatalf("Unlock: %v", err)
	}
	if snap2.Account.Email != "tester@nonepwd.local" {
		t.Fatalf("unexpected account email: %s", snap2.Account.Email)
	}

	c2.StartWebSocket()
	select {
	case <-wsConnectedCh:
	case <-time.After(5 * time.Second):
		t.Fatalf("timed out waiting for WebSocket connection")
	}

	// Create Login item, Card item, and Identity item.
	loginItem, err := c2.SaveItem(ctx, npcore.VaultItemPayload{
		VaultID:  personalVaultID,
		Category: npcore.CategoryLogin,
		Title:    "GitHub",
		URLs:     []string{"https://github.com/login"},
		Username: "octocat",
		Password: "gh-secret-password",
		TOTP:     "JBSWY3DPEHPK3PXP",
		Notes:    "主开发账号",
	}, true)
	if err != nil {
		t.Fatalf("SaveItem login: %v", err)
	}

	// Edit login item.
	loginItem.Username = "octocat-updated"
	if _, err := c2.SaveItem(ctx, loginItem, false); err != nil {
		t.Fatalf("SaveItem edit login: %v", err)
	}

	// Create Card item.
	_, err = c2.SaveItem(ctx, npcore.VaultItemPayload{
		VaultID:  personalVaultID,
		Category: npcore.CategoryCard,
		Title:    "招商银行 Visa",
		Card: &npcore.CardDetails{
			CardholderName: "LI MING",
			Number:         "4222333344445555",
			ExpMonth:       "12",
			ExpYear:        "2030",
			CVV:            "888",
			Brand:          "Visa",
		},
	}, true)
	if err != nil {
		t.Fatalf("SaveItem card: %v", err)
	}

	// Create Identity item.
	_, err = c2.SaveItem(ctx, npcore.VaultItemPayload{
		VaultID:  personalVaultID,
		Category: npcore.CategoryIdentity,
		Title:    "常用收货身份",
		Identity: &npcore.IdentityDetails{
			FullName:   "李明",
			FirstName:  "明",
			LastName:   "李",
			Email:      "liming@example.com",
			Phone:      "13900001111",
			Company:    "NonePwd Labs",
			Address1:   "科技园南区 8 栋",
			Address2:   "1201 室",
			City:       "深圳",
			State:      "广东",
			PostalCode: "518000",
			Country:    "中国",
		},
	}, true)
	if err != nil {
		t.Fatalf("SaveItem identity: %v", err)
	}

	// Simulate incoming OTP email and verify X25519 sealed-box decryption over WebSocket push.
	if err := c2.SimulateEmail(ctx, "GitHub <noreply@github.com>", "login@mail.nonepwd.local", "[GitHub] Verification Code", "Your GitHub verification code is: 739184"); err != nil {
		t.Fatalf("SimulateEmail: %v", err)
	}

	select {
	case pushed := <-wsOTPCh:
		if pushed.OTPCode != "739184" {
			t.Fatalf("expected pushed OTP 739184, got %q (%+v)", pushed.OTPCode, pushed)
		}
	case <-time.After(5 * time.Second):
		t.Fatalf("timed out waiting for WebSocket email.received OTP push")
	}

	// Verify fresh sync decrypts all 3 items cleanly.
	synced, err := c2.Sync(ctx)
	if err != nil {
		t.Fatalf("Sync: %v", err)
	}
	if len(synced.Items) != 3 {
		t.Fatalf("expected 3 decrypted items, got %d", len(synced.Items))
	}
	c2.Lock(ctx)
}
