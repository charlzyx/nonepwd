package main

import (
	"fmt"
	"strings"

	"github.com/egoist/asuka/colors"
	"github.com/egoist/asuka/fonts"
	"github.com/egoist/asuka/signal"
	"github.com/egoist/asuka/ui"
)

func ItemDetailView(s *AppState) ui.Node {
	return ui.Dynamic(func() ui.Node {
		it := s.ActiveItemGet()
		if it == nil {
			return ui.Column(ui.Style{
				Grow:       1,
				Justify:    ui.JustifyCenter,
				Align:      ui.AlignCenter,
				Padding:    ui.All(32),
				Gap:        10,
				Background: colors.GroupedBackground,
			},
				ui.Symbol("shield.lefthalf.filled", ui.Style{
					Font:  fonts.LargeTitle,
					Color: colors.TertiaryLabel,
				}),
				ui.StaticText("从左侧列表选择凭据查看详情", ui.Style{
					Font:  fonts.Headline,
					Color: colors.Label,
				}),
				ui.StaticText("支持实时 2FA 动态码倒计时、30 秒自动清空剪贴板、银行卡与身份地址管理", ui.Style{
					Font:  fonts.Footnote,
					Color: colors.SecondaryLabel,
				}),
			)
		}

		item := *it
		vaultName := s.VaultName(item.VaultID)
		matchedOTP := s.MatchedEmailOTP(&item)
		reveal := s.revealSecret.Get()

		monoBody := fonts.Font{Style: fonts.Body.Style, Family: "monospace"}
		monoLarge := fonts.Font{Style: fonts.Title2.Style, Family: "monospace", Weight: fonts.Bold}

		var sections []ui.Node

		// 1. Header
		sections = append(sections,
			ui.Row(ui.Style{
				Justify: ui.JustifySpaceBetween,
				Align:   ui.AlignCenter,
				Gap:     12,
			},
				ui.Column(ui.Style{Gap: 6, Grow: 1},
					ui.Row(ui.Style{Gap: 8, Align: ui.AlignCenter},
						badgeChip(vaultName, colors.Accent),
						badgeChip(CategoryLabel(item.Category), colors.SecondaryLabel),
					),
					ui.StaticText(item.Title, ui.Style{
						Font:  fonts.Title.Weighted(fonts.Bold),
						Color: colors.Label,
					}),
				),
				ui.Row(ui.Style{Gap: 8, Align: ui.AlignCenter},
					ui.Button(ui.ButtonProps{
						Title: ui.Val(func() string {
							if item.Favorite {
								return "已收藏"
							}
							return "收藏"
						}()),
						Icon: func() ui.Icon {
							if item.Favorite {
								return "star.fill"
							}
							return "star"
						}(),
						Variant: ui.ButtonBordered,
						OnPress: func() { s.ToggleFavorite(item) },
					}),
					ui.Button(ui.ButtonProps{
						Title:   ui.Val("编辑"),
						Icon:    "pencil",
						Variant: ui.ButtonBordered,
						OnPress: func() { s.OpenEditEditor(item) },
					}),
					ui.Button(ui.ButtonProps{
						Title:   ui.Val("删除"),
						Icon:    "trash",
						Variant: ui.ButtonBordered,
						OnPress: func() { s.ConfirmDeleteItem(item) },
					}),
				),
			),
		)

		// 2. Matched Live Email OTP Banner (via WebSocket / Sync)
		if matchedOTP != nil && matchedOTP.OTPCode != "" {
			otpCode := matchedOTP.OTPCode
			sender := matchedOTP.SenderDomain
			if sender == "" {
				sender = matchedOTP.From
			}
			sections = append(sections,
				ui.Row(ui.Style{
					Padding:      ui.All(14),
					CornerRadius: 12,
					Background:   colors.SecondaryGroupedBackground,
					BorderWidth:  1,
					BorderColor:  colors.Green,
					Justify:      ui.JustifySpaceBetween,
					Align:        ui.AlignCenter,
					Gap:          12,
				},
					ui.Row(ui.Style{Align: ui.AlignCenter, Gap: 12},
						ui.Symbol("envelope.badge.fill", ui.Style{
							Font:  fonts.Title2,
							Color: colors.Green,
						}),
						ui.Column(ui.Style{Gap: 2},
							ui.StaticText("最新关联邮箱验证码 · "+sender, ui.Style{
								Font:  fonts.Caption.Weighted(fonts.Semibold),
								Color: colors.Green,
							}),
							ui.StaticText(otpCode, ui.Style{
								Font:  monoLarge,
								Color: colors.Label,
							}),
						),
					),
					ui.Button(ui.ButtonProps{
						Title:   ui.Val("复制验证码"),
						Icon:    "doc.on.doc",
						Variant: ui.ButtonFilled,
						OnPress: func() { s.CopyWithAutoClear("邮箱验证码", otpCode) },
					}),
				),
			)
		}

		// 3. Login & Primary Secret Fields Card
		hasPrimary := item.Username != "" || item.Password != "" || item.TOTP != "" || item.EmailAlias != "" || len(item.URLs) > 0
		if hasPrimary {
			var rows []ui.Node
			if item.Username != "" {
				uname := item.Username
				rows = append(rows, detailFieldRow(
					"用户名 / 邮箱",
					uname,
					fonts.Body,
					ui.Button(ui.ButtonProps{
						Title:   ui.Val("复制用户名"),
						Icon:    "doc.on.doc",
						Variant: ui.ButtonBordered,
						OnPress: func() { s.CopyWithAutoClear("用户名", uname) },
					}),
				))
			}
			if item.Password != "" {
				pw := item.Password
				shownPw := "••••••••••••••••••••"
				if reveal {
					shownPw = pw
				}
				rows = append(rows, detailFieldRow(
					"密码 / 密钥",
					shownPw,
					monoBody,
					ui.Row(ui.Style{Gap: 8},
						ui.Button(ui.ButtonProps{
							Title: ui.Val(func() string {
								if reveal {
									return "隐藏"
								}
								return "显示"
							}()),
							Variant: ui.ButtonBordered,
							OnPress: func() { s.revealSecret.Update(func(v bool) bool { return !v }) },
						}),
						ui.Button(ui.ButtonProps{
							Title:   ui.Val("复制密码"),
							Icon:    "doc.on.doc",
							Variant: ui.ButtonFilled,
							OnPress: func() { s.CopyWithAutoClear("密码", pw) },
						}),
					),
				))
			}
			if strings.TrimSpace(item.TOTP) != "" {
				rows = append(rows, liveTOTPRow(s))
			}
			if item.EmailAlias != "" {
				alias := item.EmailAlias
				rows = append(rows, detailFieldRow(
					"绑定掩码邮箱别名",
					alias,
					monoBody,
					ui.Button(ui.ButtonProps{
						Title:   ui.Val("复制别名"),
						Variant: ui.ButtonBordered,
						OnPress: func() { s.CopyWithAutoClear("邮箱别名", alias) },
					}),
				))
			}
			for _, u := range item.URLs {
				targetURL := u
				rows = append(rows, detailFieldRow(
					"关联网址",
					targetURL,
					fonts.Subheadline,
					ui.Row(ui.Style{Gap: 8},
						ui.Button(ui.ButtonProps{
							Title:   ui.Val("打开"),
							Icon:    "arrow.up.right.square",
							Variant: ui.ButtonBordered,
							OnPress: func() { ui.OpenURL(targetURL) },
						}),
						ui.Button(ui.ButtonProps{
							Title:   ui.Val("复制"),
							Variant: ui.ButtonBordered,
							OnPress: func() { s.CopyWithAutoClear("网址", targetURL) },
						}),
					),
				))
			}
			sections = append(sections, cardContainer("登录与安全凭据", rows...))
		}

		// 4. Credit Card Details Section
		if item.Card != nil && !item.Card.IsEmpty() {
			c := item.Card
			var cardRows []ui.Node
			if c.Brand != "" {
				cardRows = append(cardRows, detailFieldRow("卡组织 / 品牌", c.Brand, fonts.Body))
			}
			if c.CardholderName != "" {
				holder := c.CardholderName
				cardRows = append(cardRows, detailFieldRow(
					"持卡人姓名",
					holder,
					fonts.Body,
					ui.Button(ui.ButtonProps{
						Title:   ui.Val("复制"),
						Variant: ui.ButtonBordered,
						OnPress: func() { s.CopyWithAutoClear("持卡人姓名", holder) },
					}),
				))
			}
			if c.Number != "" {
				num := c.Number
				displayNum := MaskCardNumber(num)
				if reveal {
					displayNum = FormatCardNumberSpaced(num)
				}
				cardRows = append(cardRows, detailFieldRow(
					"银行卡号",
					displayNum,
					monoBody,
					ui.Row(ui.Style{Gap: 8},
						ui.Button(ui.ButtonProps{
							Title: ui.Val(func() string {
								if reveal {
									return "隐藏"
								}
								return "显示"
							}()),
							Variant: ui.ButtonBordered,
							OnPress: func() { s.revealSecret.Update(func(v bool) bool { return !v }) },
						}),
						ui.Button(ui.ButtonProps{
							Title:   ui.Val("复制卡号"),
							Icon:    "doc.on.doc",
							Variant: ui.ButtonFilled,
							OnPress: func() { s.CopyWithAutoClear("银行卡号", num) },
						}),
					),
				))
			}
			if c.ExpMonth != "" || c.ExpYear != "" {
				exp := strings.Trim(c.ExpMonth+"/"+c.ExpYear, "/")
				cardRows = append(cardRows, detailFieldRow(
					"有效期 (MM/YYYY)",
					exp,
					monoBody,
					ui.Button(ui.ButtonProps{
						Title:   ui.Val("复制"),
						Variant: ui.ButtonBordered,
						OnPress: func() { s.CopyWithAutoClear("有效期", exp) },
					}),
				))
			}
			if c.CVV != "" {
				cvv := c.CVV
				displayCVV := "•••"
				if reveal {
					displayCVV = cvv
				}
				cardRows = append(cardRows, detailFieldRow(
					"安全码 (CVV / CVC)",
					displayCVV,
					monoBody,
					ui.Row(ui.Style{Gap: 8},
						ui.Button(ui.ButtonProps{
							Title: ui.Val(func() string {
								if reveal {
									return "隐藏"
								}
								return "显示"
							}()),
							Variant: ui.ButtonBordered,
							OnPress: func() { s.revealSecret.Update(func(v bool) bool { return !v }) },
						}),
						ui.Button(ui.ButtonProps{
							Title:   ui.Val("复制 CVV"),
							Variant: ui.ButtonBordered,
							OnPress: func() { s.CopyWithAutoClear("安全码 CVV", cvv) },
						}),
					),
				))
			}
			sections = append(sections, cardContainer("银行卡信息", cardRows...))
		}

		// 5. Identity / Address Details Section
		if item.Identity != nil && !item.Identity.IsEmpty() {
			id := item.Identity
			var idRows []ui.Node
			name := id.FullName
			if name == "" {
				name = strings.TrimSpace(id.LastName + " " + id.FirstName)
			}
			if name != "" {
				n := name
				idRows = append(idRows, detailFieldRow(
					"姓名",
					n,
					fonts.Body,
					ui.Button(ui.ButtonProps{
						Title:   ui.Val("复制姓名"),
						Variant: ui.ButtonBordered,
						OnPress: func() { s.CopyWithAutoClear("姓名", n) },
					}),
				))
			}
			if id.Email != "" {
				em := id.Email
				idRows = append(idRows, detailFieldRow(
					"电子邮箱",
					em,
					fonts.Body,
					ui.Button(ui.ButtonProps{
						Title:   ui.Val("复制邮箱"),
						Variant: ui.ButtonBordered,
						OnPress: func() { s.CopyWithAutoClear("邮箱", em) },
					}),
				))
			}
			if id.Phone != "" {
				ph := id.Phone
				idRows = append(idRows, detailFieldRow(
					"手机 / 电话",
					ph,
					monoBody,
					ui.Button(ui.ButtonProps{
						Title:   ui.Val("复制电话"),
						Variant: ui.ButtonBordered,
						OnPress: func() { s.CopyWithAutoClear("电话", ph) },
					}),
				))
			}
			if id.Company != "" {
				comp := id.Company
				idRows = append(idRows, detailFieldRow(
					"公司 / 组织",
					comp,
					fonts.Body,
					ui.Button(ui.ButtonProps{
						Title:   ui.Val("复制"),
						Variant: ui.ButtonBordered,
						OnPress: func() { s.CopyWithAutoClear("公司", comp) },
					}),
				))
			}
			if fullAddr := FormatFullAddress(id); fullAddr != "" {
				addr := fullAddr
				idRows = append(idRows, detailFieldRow(
					"详细地址",
					addr,
					fonts.Body,
					ui.Button(ui.ButtonProps{
						Title:   ui.Val("复制完整地址"),
						Icon:    "doc.on.doc",
						Variant: ui.ButtonFilled,
						OnPress: func() { s.CopyWithAutoClear("地址", addr) },
					}),
				))
			}
			if id.PostalCode != "" {
				zip := id.PostalCode
				idRows = append(idRows, detailFieldRow(
					"邮政编码",
					zip,
					monoBody,
					ui.Button(ui.ButtonProps{
						Title:   ui.Val("复制邮编"),
						Variant: ui.ButtonBordered,
						OnPress: func() { s.CopyWithAutoClear("邮编", zip) },
					}),
				))
			}
			sections = append(sections, cardContainer("身份与收货地址", idRows...))
		}

		// 6. Custom Fields
		if len(item.CustomFields) > 0 {
			var cfRows []ui.Node
			for _, cf := range item.CustomFields {
				field := cf
				val := field.Value
				if field.Type == "concealed" && !reveal {
					val = "••••••••••••"
				}
				cfRows = append(cfRows, detailFieldRow(
					field.Label,
					val,
					monoBody,
					ui.Button(ui.ButtonProps{
						Title:   ui.Val("复制"),
						Variant: ui.ButtonBordered,
						OnPress: func() { s.CopyWithAutoClear(field.Label, field.Value) },
					}),
				))
			}
			sections = append(sections, cardContainer("自定义字段", cfRows...))
		}

		// 7. Notes
		if item.Notes != "" {
			sections = append(sections,
				cardContainer("安全备注",
					ui.StaticText(item.Notes, ui.Style{
						Font:  fonts.Body,
						Color: colors.Label,
					}),
				),
			)
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
		}, sections...)
	})
}

func liveTOTPRow(s *AppState) ui.Node {
	monoLarge := fonts.Font{Style: fonts.Title2.Style, Family: "monospace", Weight: fonts.Bold}

	return ui.Row(ui.Style{
		Justify: ui.JustifySpaceBetween,
		Align:   ui.AlignCenter,
		Gap:     12,
	},
		ui.Row(ui.Style{Align: ui.AlignCenter, Gap: 12},
			ui.ProgressRing(s.totpProgress, ui.StyleFunc(func() ui.Style {
				c := colors.Accent
				if rem := s.totpRemaining.Get(); rem > 0 && rem <= 5 {
					c = colors.Red
				}
				return ui.Style{
					Width:  ui.Pt(28),
					Height: ui.Pt(28),
					Color:  c,
				}
			})),
			ui.Column(ui.Style{Gap: 2},
				ui.Text(signal.Func(func() string {
					return fmt.Sprintf("一次性动态码 (2FA TOTP · 剩余 %ds)", s.totpRemaining.Get())
				}), ui.StyleFunc(func() ui.Style {
					c := colors.SecondaryLabel
					if rem := s.totpRemaining.Get(); rem > 0 && rem <= 5 {
						c = colors.Red
					}
					return ui.Style{
						Font:  fonts.Caption.Weighted(fonts.Medium),
						Color: c,
					}
				})),
				ui.Text(s.totpCode, ui.Style{
					Font:  monoLarge,
					Color: colors.Label,
				}),
			),
		),
		ui.Button(ui.ButtonProps{
			Title:   ui.Val("复制动态码"),
			Icon:    "clock.badge.checkmark",
			Variant: ui.ButtonTinted,
			OnPress: func() {
				raw := strings.ReplaceAll(s.totpCode.Peek(), " ", "")
				s.CopyWithAutoClear("2FA 动态码", raw)
			},
		}),
	)
}

func badgeChip(text string, color ui.Color) ui.Node {
	return ui.View(ui.ViewProps{
		Style: ui.Style{
			Padding:      ui.Symmetric(3, 8),
			CornerRadius: 6,
			Background:   colors.SecondaryGroupedBackground,
			BorderWidth:  1,
			BorderColor:  colors.Separator,
		},
	},
		ui.StaticText(text, ui.Style{
			Font:  fonts.Caption.Weighted(fonts.Medium),
			Color: color,
		}),
	)
}

func cardContainer(title string, children ...ui.Node) ui.Node {
	var body []ui.Node
	body = append(body, ui.StaticText(title, ui.Style{
		Font:  fonts.Caption.Weighted(fonts.Semibold),
		Color: colors.SecondaryLabel,
	}))
	for i, ch := range children {
		if i > 0 {
			body = append(body, ui.View(ui.ViewProps{
				Style: ui.Style{Height: ui.Pt(1), Background: colors.Separator},
			}))
		}
		body = append(body, ch)
	}
	return ui.Column(ui.Style{
		Padding:      ui.All(16),
		Gap:          12,
		Background:   colors.SecondaryGroupedBackground,
		CornerRadius: 12,
		BorderWidth:  1,
		BorderColor:  colors.Separator,
	}, body...)
}

func detailFieldRow(label, value string, valueFont fonts.Font, trailing ...ui.Node) ui.Node {
	children := []ui.Node{
		ui.Column(ui.Style{Gap: 3, Grow: 1},
			ui.StaticText(label, ui.Style{
				Font:  fonts.Caption,
				Color: colors.SecondaryLabel,
			}),
			ui.StaticText(value, ui.Style{
				Font:  valueFont,
				Color: colors.Label,
			}),
		),
	}
	children = append(children, trailing...)
	return ui.Row(ui.Style{
		Justify: ui.JustifySpaceBetween,
		Align:   ui.AlignCenter,
		Gap:     12,
	}, children...)
}
