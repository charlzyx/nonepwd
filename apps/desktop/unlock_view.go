package main

import (
	"github.com/egoist/asuka/colors"
	"github.com/egoist/asuka/fonts"
	"github.com/egoist/asuka/signal"
	"github.com/egoist/asuka/ui"

	"desktop/npcore"
)

func UnlockView(s *AppState) ui.Node {
	monoFont := fonts.Font{Style: fonts.Subheadline.Style, Family: "monospace"}

	return ui.Scroll(ui.ScrollProps{
		Style: ui.Style{
			Grow:       1,
			Background: colors.GroupedBackground,
		},
		ContentStyle: ui.Style{
			Grow:    1,
			Justify: ui.JustifyCenter,
			Align:   ui.AlignCenter,
			Padding: ui.All(32),
		},
	},
		ui.Column(ui.Style{
			Width:        ui.Pt(460),
			Padding:      ui.All(28),
			Gap:          16,
			Background:   colors.SecondaryGroupedBackground,
			CornerRadius: 14,
			BorderWidth:  1,
			BorderColor:  colors.Separator,
		},
			// Brand Header
			ui.Row(ui.Style{Align: ui.AlignCenter, Gap: 12},
				ui.View(ui.ViewProps{
					Style: ui.Style{
						Width:        ui.Pt(42),
						Height:       ui.Pt(42),
						CornerRadius: 10,
						Background:   colors.Accent,
						Justify:      ui.JustifyCenter,
						Align:        ui.AlignCenter,
					},
				},
					ui.Symbol("lock.shield.fill", ui.Style{
						Font:  fonts.Title2,
						Color: colors.OnAccent,
					}),
				),
				ui.Column(ui.Style{Gap: 2, Grow: 1},
					ui.StaticText("NonePwd 密码库", ui.Style{
						Font:  fonts.Title2.Weighted(fonts.Semibold),
						Color: colors.Label,
					}),
					ui.StaticText("零知识端到端加密 · Rust Core 原生驱动", ui.Style{
						Font:  fonts.Footnote,
						Color: colors.SecondaryLabel,
					}),
				),
			),

			// Mode Switcher: Unlock vs Initialize
			ui.Segmented(ui.SegmentedProps{
				Segments: ui.Val([]string{"解锁已有账号", "初始化新服务端"}),
				Selected: s.authMode,
			}),

			// Server URL + Probe button
			ui.Column(ui.Style{Gap: 6},
				ui.StaticText("服务端地址", ui.Style{
					Font:  fonts.Footnote.Weighted(fonts.Medium),
					Color: colors.SecondaryLabel,
				}),
				ui.Row(ui.Style{Gap: 8, Align: ui.AlignCenter},
					ui.TextField(ui.TextFieldProps{
						Value:       s.serverURL,
						Placeholder: ui.Val("http://127.0.0.1:8787"),
						Style:       ui.Style{Grow: 1, Font: monoFont},
						OnSubmit:    func() { s.ProbeServer() },
					}),
					ui.Button(ui.ButtonProps{
						Title:   ui.Val("检测连接"),
						Variant: ui.ButtonBordered,
						OnPress: func() { s.ProbeServer() },
					}),
				),
				ui.Show(signal.Func(func() bool { return s.serverStatus.Get() != "" }), func() ui.Node {
					return ui.Text(s.serverStatus, ui.Style{
						Font:  fonts.Caption,
						Color: colors.SecondaryLabel,
					})
				}),
			),

			// Setup-only fields (Email + Optional Alias Domain)
			ui.Show(signal.Func(func() bool { return s.authMode.Get() == 1 }), func() ui.Node {
				return ui.Column(ui.Style{Gap: 12},
					ui.Column(ui.Style{Gap: 6},
						ui.StaticText("管理员邮箱", ui.Style{
							Font:  fonts.Footnote.Weighted(fonts.Medium),
							Color: colors.SecondaryLabel,
						}),
						ui.TextField(ui.TextFieldProps{
							Value:       s.setupEmail,
							Placeholder: ui.Val("you@example.com"),
						}),
					),
					ui.Column(ui.Style{Gap: 6},
						ui.StaticText("掩码邮箱域名（可选，用于生成别名收验证码）", ui.Style{
							Font:  fonts.Footnote.Weighted(fonts.Medium),
							Color: colors.SecondaryLabel,
						}),
						ui.TextField(ui.TextFieldProps{
							Value:       s.setupAliasDom,
							Placeholder: ui.Val("mail.example.com"),
							Style:       ui.Style{Font: monoFont},
						}),
					),
				)
			}),

			// Secret Key (NP3-...)
			ui.Column(ui.Style{Gap: 6},
				ui.Row(ui.Style{Justify: ui.JustifySpaceBetween, Align: ui.AlignCenter},
					ui.StaticText("Secret Key (设备密钥)", ui.Style{
						Font:  fonts.Footnote.Weighted(fonts.Medium),
						Color: colors.SecondaryLabel,
					}),
					ui.Show(signal.Func(func() bool { return s.authMode.Get() == 1 }), func() ui.Node {
						return ui.Row(ui.Style{Gap: 6},
							ui.Button(ui.ButtonProps{
								Title:   ui.Val("生成新密钥"),
								Variant: ui.ButtonBordered,
								OnPress: func() {
									if sk, err := npcore.GenerateSecretKey(); err == nil {
										s.secretKey.Set(sk)
									}
								},
							}),
							ui.Button(ui.ButtonProps{
								Title:   ui.Val("复制"),
								Variant: ui.ButtonBordered,
								OnPress: func() {
									ui.Copy(s.secretKey.Peek())
								},
							}),
						)
					}),
				),
				ui.TextField(ui.TextFieldProps{
					Value:       s.secretKey,
					Placeholder: ui.Val("NP3-XXXX-XXXX-XXXX-XXXX-XXXX"),
					Style:       ui.Style{Font: monoFont},
				}),
			),

			// Master Password
			ui.Column(ui.Style{Gap: 6},
				ui.StaticText("主密码 (Master Password)", ui.Style{
					Font:  fonts.Footnote.Weighted(fonts.Medium),
					Color: colors.SecondaryLabel,
				}),
				ui.TextField(ui.TextFieldProps{
					Value:       s.masterPassword,
					Placeholder: ui.Val("输入主密码（仅用于本地派生密钥，绝不落盘或上传）"),
					Secure:      true,
					OnSubmit:    func() { s.DoUnlockOrSetup() },
				}),
			),

			// Remember URL + Secret Key toggle
			ui.Row(ui.Style{Justify: ui.JustifySpaceBetween, Align: ui.AlignCenter},
				ui.Row(ui.Style{Gap: 8, Align: ui.AlignCenter},
					ui.Toggle(ui.ToggleProps{
						Value:    s.rememberDevice,
						Checkbox: true,
					}),
					ui.StaticText("在此设备记住服务端地址与 Secret Key（永不保存主密码）", ui.Style{
						Font:  fonts.Caption,
						Color: colors.SecondaryLabel,
					}),
				),
				ui.Show(signal.Func(func() bool { return s.secretKey.Get() != "" }), func() ui.Node {
					return ui.Button(ui.ButtonProps{
						Title:   ui.Val("清除密钥"),
						Variant: ui.ButtonPlain,
						OnPress: func() { s.ForgetSavedSecretKey() },
					})
				}),
			),

			// Error display
			ui.Show(signal.Func(func() bool { return s.authError.Get() != "" }), func() ui.Node {
				return ui.View(ui.ViewProps{
					Style: ui.Style{
						Padding:      ui.All(10),
						CornerRadius: 8,
						BorderWidth:  1,
						BorderColor:  colors.Red,
					},
				},
					ui.Text(s.authError, ui.Style{
						Font:  fonts.Footnote,
						Color: colors.Red,
					}),
				)
			}),

			// Submit button
			ui.Button(ui.ButtonProps{
				Title: signal.Func(func() string {
					if s.busy.Get() {
						return "正在通过 PBKDF2-SHA256 派生密钥并解密..."
					}
					if s.authMode.Get() == 1 {
						return "初始化并解锁密码库"
					}
					return "解锁密码库"
				}),
				Variant:  ui.ButtonFilled,
				Disabled: s.busy,
				OnPress:  func() { s.DoUnlockOrSetup() },
			}),
		),
	)
}
