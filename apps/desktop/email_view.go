package main

import (
	"context"
	"fmt"
	"time"

	"github.com/egoist/asuka/colors"
	"github.com/egoist/asuka/fonts"
	"github.com/egoist/asuka/signal"
	"github.com/egoist/asuka/ui"

	"desktop/client"
)

func EmailOTPView(s *AppState) ui.Node {
	monoLarge := fonts.Font{Style: fonts.Title2.Style, Family: "monospace", Weight: fonts.Bold}

	sendTestEmail := func() {
		go func() {
			ctx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
			defer cancel()
			code := fmt.Sprintf("%06d", time.Now().UnixNano()%1_000_000)
			err := s.api.SimulateEmail(
				ctx,
				"GitHub <noreply@github.com>",
				"verify@nonepwd.local",
				"[GitHub] 登录安全验证码",
				fmt.Sprintf("您好，您本次登录的验证码为：%s，请在 10 分钟内完成验证。", code),
			)
			if err != nil {
				ui.Post(func() {
					s.statusBanner.Set("发送模拟邮件失败: " + err.Error())
				})
			}
		}()
	}

	deleteEmail := func(id string) {
		go func() {
			ctx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
			defer cancel()
			err := s.api.DeleteEmail(ctx, id)
			snap := s.api.Snapshot()
			ui.Post(func() {
				if err != nil {
					s.statusBanner.Set("删除邮件失败: " + err.Error())
					return
				}
				s.applySnapshot(snap)
			})
		}()
	}

	return ui.Scroll(ui.ScrollProps{
		Style: ui.Style{
			Grow:       1,
			Background: colors.GroupedBackground,
		},
		ContentStyle: ui.Style{
			Padding: ui.All(24),
			Gap:     16,
		},
	},
		// Header
		ui.Row(ui.Style{
			Justify: ui.JustifySpaceBetween,
			Align:   ui.AlignCenter,
		},
			ui.Column(ui.Style{Gap: 4},
				ui.StaticText("实时邮箱验证码收件流", ui.Style{
					Font:  fonts.Title2.Weighted(fonts.Bold),
					Color: colors.Label,
				}),
				ui.StaticText("邮件由服务端以账户 X25519 公钥密封存储，通过 WebSocket 实时推送并在本地内存解密", ui.Style{
					Font:  fonts.Footnote,
					Color: colors.SecondaryLabel,
				}),
			),
			ui.Row(ui.Style{Gap: 8},
				ui.Button(ui.ButtonProps{
					Title:   ui.Val("模拟测试验证码推送"),
					Icon:    "paperplane.fill",
					Variant: ui.ButtonBordered,
					OnPress: sendTestEmail,
				}),
				ui.Button(ui.ButtonProps{
					Title:   ui.Val("刷新"),
					Icon:    "arrow.clockwise",
					Variant: ui.ButtonBordered,
					OnPress: func() { s.RefreshSync() },
				}),
			),
		),

		ui.Show(
			signal.Func(func() bool { return len(s.emails.Get()) == 0 }),
			func() ui.Node {
				return ui.Column(ui.Style{
					Padding:      ui.All(40),
					Align:        ui.AlignCenter,
					Gap:          10,
					Background:   colors.SecondaryGroupedBackground,
					CornerRadius: 12,
					BorderWidth:  1,
					BorderColor:  colors.Separator,
				},
					ui.Symbol("tray", ui.Style{
						Font:  fonts.LargeTitle,
						Color: colors.TertiaryLabel,
					}),
					ui.StaticText("暂无加密验证码邮件", ui.Style{
						Font:  fonts.Headline,
						Color: colors.Label,
					}),
					ui.StaticText("开启 IMAP 或 Cloudflare Email Worker 后，新到达的验证码会通过 WebSocket 即时显示在这里", ui.Style{
						Font:  fonts.Footnote,
						Color: colors.SecondaryLabel,
					}),
				)
			},
			func() ui.Node {
				return ui.Column(ui.Style{Gap: 12},
					ui.For(
						s.emails,
						func(em client.DecryptedEmail) string { return em.ID },
						func(emAcc signal.Accessor[client.DecryptedEmail], _ signal.Accessor[int]) ui.Node {
							return ui.Dynamic(func() ui.Node {
								em := emAcc.Get()
								var body []ui.Node

								body = append(body,
									ui.Row(ui.Style{
										Justify: ui.JustifySpaceBetween,
										Align:   ui.AlignCenter,
										Gap:     12,
									},
										ui.Column(ui.Style{Gap: 3, Grow: 1},
											ui.Row(ui.Style{Gap: 8, Align: ui.AlignCenter},
												badgeChip(em.Source, colors.Accent),
												ui.StaticText(em.From, ui.Style{
													Font:  fonts.Footnote.Weighted(fonts.Semibold),
													Color: colors.Label,
												}),
												ui.StaticText("→ "+em.To, ui.Style{
													Font:  fonts.Caption,
													Color: colors.SecondaryLabel,
												}),
											),
											ui.StaticText(em.Subject, ui.Style{
												Font:  fonts.Headline,
												Color: colors.Label,
											}),
										),
										ui.Button(ui.ButtonProps{
											Title:   ui.Val("删除"),
											Icon:    "trash",
											Variant: ui.ButtonPlain,
											OnPress: func() { deleteEmail(em.ID) },
										}),
									),
								)

								if em.OTPCode != "" {
									code := em.OTPCode
									body = append(body,
										ui.Row(ui.Style{
											Padding:      ui.All(12),
											CornerRadius: 10,
											Background:   colors.Background,
											BorderWidth:  1,
											BorderColor:  colors.Separator,
											Justify:      ui.JustifySpaceBetween,
											Align:        ui.AlignCenter,
										},
											ui.Column(ui.Style{Gap: 2},
												ui.StaticText(fmt.Sprintf("提取验证码（置信度 %.0f%%）", em.Confidence*100), ui.Style{
													Font:  fonts.Caption,
													Color: colors.SecondaryLabel,
												}),
												ui.StaticText(code, ui.Style{
													Font:  monoLarge,
													Color: colors.Label,
												}),
											),
											ui.Button(ui.ButtonProps{
												Title:   ui.Val("复制验证码"),
												Icon:    "doc.on.doc",
												Variant: ui.ButtonFilled,
												OnPress: func() { s.CopyWithAutoClear("邮箱验证码", code) },
											}),
										),
									)
								}

								if em.MagicLink != "" {
									link := em.MagicLink
									body = append(body,
										ui.Row(ui.Style{Gap: 8},
											ui.Button(ui.ButtonProps{
												Title:   ui.Val("打开登录验证链接 (Magic Link)"),
												Icon:    "arrow.up.right.square",
												Variant: ui.ButtonBordered,
												OnPress: func() { ui.OpenURL(link) },
											}),
										),
									)
								}

								if em.Snippet != "" {
									body = append(body,
										ui.StaticText(em.Snippet, ui.Style{
											Font:  fonts.Footnote,
											Color: colors.SecondaryLabel,
											Lines: 2,
										}),
									)
								}

								return ui.Column(ui.Style{
									Padding:      ui.All(16),
									Gap:          10,
									Background:   colors.SecondaryGroupedBackground,
									CornerRadius: 12,
									BorderWidth:  1,
									BorderColor:  colors.Separator,
								}, body...)
							})
						},
					),
				)
			},
		),
	)
}
