package main

import (
	"context"

	"github.com/egoist/asuka/app"
	"github.com/egoist/asuka/colors"
	"github.com/egoist/asuka/signal"
	"github.com/egoist/asuka/ui"
)

func App() ui.Node {
	cfgDir, _ := app.ConfigDir()
	return AppWithConfigDir(cfgDir)
}

func AppWithConfigDir(cfgDir string) ui.Node {
	// Follow macOS system Light / Dark appearance automatically.
	ui.SetColorScheme(ui.ColorSchemeSystem)

	state := NewAppStateWithConfigDir(cfgDir)
	state.StartBackgroundTickers()

	app.OnQuit(func(_ *app.QuitEvent) {
		state.api.Lock(context.Background())
	})

	ui.UseKeys(ui.KeyMap{
		ui.Cmd("n"): func() {
			if state.unlocked.Peek() {
				state.OpenCreateEditor()
			}
		},
		ui.Cmd("r"): func() {
			if state.unlocked.Peek() {
				state.RefreshSync()
			}
		},
		ui.Cmd("l"): func() {
			if state.unlocked.Peek() {
				state.LockVault()
			}
		},
	})

	return ui.Column(ui.Style{
		Grow:       1,
		Background: colors.Background,
	},
		ui.MenuBar(signal.Func(func() []ui.MenuBarMenu {
			unlocked := state.unlocked.Get()
			return []ui.MenuBarMenu{
				{
					Title: "NonePwd",
					Items: []ui.MenuItem{
						{
							Title:    "同步密码库",
							Shortcut: ui.Cmd("r"),
							Disabled: !unlocked,
							OnPress:  func() { state.RefreshSync() },
						},
						{
							Title:    "锁定密码库",
							Shortcut: ui.Cmd("l"),
							Disabled: !unlocked,
							OnPress:  func() { state.LockVault() },
						},
						ui.MenuSeparator,
						ui.MenuQuit,
					},
				},
				{
					Title: "凭据",
					Items: []ui.MenuItem{
						{
							Title:    "新建条目...",
							Shortcut: ui.Cmd("n"),
							Disabled: !unlocked,
							OnPress:  func() { state.OpenCreateEditor() },
						},
						{
							Title:    "新建密码库...",
							Disabled: !unlocked,
							OnPress:  func() { state.PromptCreateVault() },
						},
						ui.MenuSeparator,
						{
							Title:    "清空剪贴板",
							Disabled: !unlocked,
							OnPress:  func() { state.ClearClipboardNow() },
						},
					},
				},
			}
		})),
		ui.Show(
			state.unlocked,
			func() ui.Node { return WorkspaceView(state) },
			func() ui.Node { return UnlockView(state) },
		),
	)
}

func main() {
	app.RunWindow(ui.WindowOptions{
		Title:     ui.Val("NonePwd 密码库"),
		Width:     1120,
		Height:    720,
		MinWidth:  880,
		MinHeight: 560,
		StateKey:  "nonepwd-main-window",
	}, App)
}
