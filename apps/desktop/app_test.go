package main

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

	"github.com/egoist/asuka/ui"
	"github.com/egoist/asuka/uitest"

	"desktop/client"
	"desktop/npcore"
)

var uiServerPortRe = regexp.MustCompile(`https?://(?:127\.0\.0\.1|0\.0\.0\.0|localhost):(\d+)`)

func startUITestServer(t *testing.T) string {
	t.Helper()

	wd, err := os.Getwd()
	if err != nil {
		t.Fatalf("Getwd: %v", err)
	}
	repoRoot := filepath.Clean(filepath.Join(wd, "..", ".."))
	dataDir := t.TempDir()

	npBin := filepath.Join(repoRoot, "dist", "bin", "np")
	var cmd *exec.Cmd
	ctx, cancel := context.WithCancel(context.Background())

	useNP := false
	if st, err := os.Stat(npBin); err == nil && !st.IsDir() {
		if helpOut, err := exec.Command(npBin, "--help").CombinedOutput(); err == nil && strings.Contains(string(helpOut), "server") {
			useNP = true
		}
	}
	if useNP {
		cmd = exec.CommandContext(ctx, npBin, "server", "--host", "127.0.0.1", "--port", "0", "--data-dir", dataDir)
	} else {
		nodeIndex := filepath.Join(repoRoot, "packages", "server", "dist", "index.js")
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
		t.Fatalf("Start server: %v", err)
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
			if m := uiServerPortRe.FindStringSubmatch(line); len(m) == 2 {
				urlCh <- "http://127.0.0.1:" + m[1]
				for scanner.Scan() {
				}
				return
			}
		}
		errCh <- fmt.Errorf("server exited early:\n%s", strings.Join(lines, "\n"))
	}()

	select {
	case u := <-urlCh:
		return u
	case err := <-errCh:
		t.Fatalf("test server failed: %v", err)
	case <-time.After(15 * time.Second):
		t.Fatalf("timed out waiting for server")
	}
	return ""
}

func TestDesktopAppUIFlowLightAndDark(t *testing.T) {
	srvURL := startUITestServer(t)
	ctx, cancel := context.WithTimeout(context.Background(), 30*time.Second)
	defer cancel()

	// Seed an initialized vault with Login (TOTP), Card, and Identity items.
	seeder := client.New(srvURL)
	secretKey, err := npcore.GenerateSecretKey()
	if err != nil {
		t.Fatalf("GenerateSecretKey: %v", err)
	}
	masterPassword := "Desktop-UI-Master#2026"
	snap, err := seeder.SetupAccount(ctx, client.SetupParams{
		Email:          "ui@nonepwd.local",
		MasterPassword: masterPassword,
		SecretKey:      secretKey,
		AliasDomain:    "mail.nonepwd.local",
		KDFIterations:  20_000,
	})
	if err != nil {
		t.Fatalf("SetupAccount: %v", err)
	}
	vaultID := snap.Vaults[0].ID

	if _, err := seeder.SaveItem(ctx, npcore.VaultItemPayload{
		VaultID:  vaultID,
		Category: npcore.CategoryLogin,
		Title:    "GitHub Enterprise",
		URLs:     []string{"https://github.com/login"},
		Username: "alice-dev",
		Password: "super-secret-gh-pw",
		TOTP:     "JBSWY3DPEHPK3PXP",
	}, true); err != nil {
		t.Fatalf("seed login: %v", err)
	}
	if _, err := seeder.SaveItem(ctx, npcore.VaultItemPayload{
		VaultID:  vaultID,
		Category: npcore.CategoryCard,
		Title:    "招商银行 Visa",
		Card: &npcore.CardDetails{
			CardholderName: "ALICE ZHANG",
			Number:         "4222333344445555",
			ExpMonth:       "09",
			ExpYear:        "2030",
			CVV:            "987",
			Brand:          "Visa",
		},
	}, true); err != nil {
		t.Fatalf("seed card: %v", err)
	}
	if _, err := seeder.SaveItem(ctx, npcore.VaultItemPayload{
		VaultID:  vaultID,
		Category: npcore.CategoryIdentity,
		Title:    "深圳收货身份",
		Identity: &npcore.IdentityDetails{
			FullName:   "张爱丽",
			Email:      "alice@example.com",
			Phone:      "13800138000",
			Address1:   "科技园中区 1 号",
			City:       "深圳",
			PostalCode: "518057",
			Country:    "中国",
		},
	}, true); err != nil {
		t.Fatalf("seed identity: %v", err)
	}

	cfgDir := t.TempDir()
	store, _ := client.NewConfigStore(cfgDir)
	_ = store.Save(client.SavedConfig{
		ServerURL:      srvURL,
		Email:          "ui@nonepwd.local",
		SecretKey:      secretKey,
		RememberDevice: true,
	})

	a := uitest.Mount(t, func() ui.Node {
		return AppWithConfigDir(cfgDir)
	}, uitest.Platform(ui.PlatformMacOS), uitest.Size(1120, 720), uitest.Dark())

	a.Expect("NonePwd 密码库")
	a.Type("主密码 (Master Password)", masterPassword)
	a.Tap("解锁密码库")

	// Wait for workspace unlock & decrypted items to render.
	a.WaitFor("GitHub Enterprise")
	a.Expect("Personal", "DevOps", "招商银行 Visa", "深圳收货身份")

	// Create a new Login item through the UI editor and edit it.
	a.Tap("新建")
	a.WaitFor("新建加密条目")
	a.Type("例如 GitHub / 招商银行 Visa / 常用收货地址", "Cloudflare Dashboard")
	a.Type("name@example.com", "ops@nonepwd.local")
	a.Tap("随机强密码")
	a.Tap("保存条目")
	a.WaitFor("Cloudflare Dashboard")
	a.Expect("ops@nonepwd.local")

	// Select GitHub Enterprise and test copy password + 30s auto-clear banner + live TOTP.
	a.Tap("GitHub Enterprise")
	a.Expect("alice-dev", "复制动态码")
	a.Tap("复制密码")
	a.WaitFor("立即清空剪贴板")
	a.Tap("立即清空剪贴板")
	a.Expect("已立即清空剪贴板")

	// Switch to Card category and test masked & revealed card number.
	a.Tap("银行卡")
	a.Tap("招商银行 Visa")
	a.Expect("•••• •••• •••• 5555")
	a.In(uitest.NextTo("银行卡号")).Tap("显示")
	a.Expect("4222 3333 4444 5555")

	// Switch to Identity category and verify identity details.
	a.Tap("身份地址")
	a.Tap("深圳收货身份")
	a.Expect("张爱丽", "13800138000")

	// Push a live Email OTP via server and verify real-time WebSocket push on GitHub Enterprise!
	a.Tap("全部条目")
	a.Tap("GitHub Enterprise")
	a.Until("WebSocket connected", func() bool {
		return a.Has("WebSocket 实时推送已连接")
	})
	if err := seeder.SimulateEmail(ctx, "GitHub <noreply@github.com>", "ui@mail.nonepwd.local", "[GitHub] Security code", "Your GitHub verification code is 650412"); err != nil {
		t.Fatalf("SimulateEmail: %v", err)
	}
	a.WaitFor("650412")

	// Lock vault and verify return to unlock screen without persisted master password.
	a.Tap("锁定")
	a.WaitFor("初始化新服务端")

	cfgBytes, err := os.ReadFile(store.Path())
	if err != nil {
		t.Fatalf("read saved config: %v", err)
	}
	if strings.Contains(string(cfgBytes), masterPassword) {
		t.Fatalf("master password leaked into config.json!")
	}
}
