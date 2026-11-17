package client

import (
	"encoding/json"
	"os"
	"path/filepath"
	"strings"
)

const DefaultServerURL = "http://127.0.0.1:8787"

// SavedConfig stores non-master-password connection preferences in the user's
// OS configuration directory (never the master password or session keys).
type SavedConfig struct {
	ServerURL      string `json:"serverUrl"`
	Email          string `json:"email,omitempty"`
	SecretKey      string `json:"secretKey,omitempty"`
	RememberDevice bool   `json:"rememberDevice"`
}

type ConfigStore struct {
	dir string
}

func NewConfigStore(customDir string) (*ConfigStore, error) {
	dir := strings.TrimSpace(customDir)
	if dir == "" {
		base, err := os.UserConfigDir()
		if err != nil {
			return nil, err
		}
		dir = filepath.Join(base, "dev.nonepwd.desktop")
	}
	return &ConfigStore{dir: dir}, nil
}

func (s *ConfigStore) Path() string {
	return filepath.Join(s.dir, "config.json")
}

func (s *ConfigStore) Load() SavedConfig {
	cfg := SavedConfig{
		ServerURL:      DefaultServerURL,
		RememberDevice: true,
	}
	data, err := os.ReadFile(s.Path())
	if err != nil {
		return cfg
	}
	var parsed SavedConfig
	if err := json.Unmarshal(data, &parsed); err != nil {
		return cfg
	}
	if strings.TrimSpace(parsed.ServerURL) != "" {
		cfg.ServerURL = NormalizeServerURL(parsed.ServerURL)
	}
	cfg.Email = strings.TrimSpace(parsed.Email)
	if parsed.RememberDevice {
		cfg.SecretKey = strings.TrimSpace(parsed.SecretKey)
		cfg.RememberDevice = true
	} else {
		cfg.RememberDevice = false
	}
	return cfg
}

func (s *ConfigStore) Save(cfg SavedConfig) error {
	if err := os.MkdirAll(s.dir, 0o700); err != nil {
		return err
	}
	clean := SavedConfig{
		ServerURL:      NormalizeServerURL(cfg.ServerURL),
		Email:          strings.TrimSpace(cfg.Email),
		RememberDevice: cfg.RememberDevice,
	}
	if cfg.RememberDevice {
		clean.SecretKey = strings.TrimSpace(cfg.SecretKey)
	}
	data, err := json.MarshalIndent(clean, "", "  ")
	if err != nil {
		return err
	}
	return os.WriteFile(s.Path(), data, 0o600)
}

func (s *ConfigStore) ClearSecretKey() error {
	cfg := s.Load()
	cfg.SecretKey = ""
	cfg.RememberDevice = false
	return s.Save(cfg)
}

func NormalizeServerURL(raw string) string {
	u := strings.TrimSpace(raw)
	if u == "" {
		return DefaultServerURL
	}
	if !strings.HasPrefix(u, "http://") && !strings.HasPrefix(u, "https://") {
		u = "http://" + u
	}
	return strings.TrimRight(u, "/")
}
