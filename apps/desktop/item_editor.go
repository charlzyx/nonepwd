package main

import (
	"github.com/egoist/asuka/colors"
	"github.com/egoist/asuka/fonts"
	"github.com/egoist/asuka/signal"
	"github.com/egoist/asuka/ui"

	"desktop/npcore"
)

func ItemEditorView(s *AppState) ui.Node {
	e := s.editor
	monoFont := fonts.Font{Style: fonts.Subheadline.Style, Family: "monospace"}

	vaultNamesAcc := signal.Func(func() []string {
		vaults := s.vaults.Get()
		out := make([]string, len(vaults))
		for i, v := range vaults {
			out[i] = v.Metadata.Name
		}
		return out
	})

	isCardOrIdentity := func(catIdx int) npcore.ItemCategory {
		if catIdx >= 0 && catIdx < len(categoryOrder) {
			return categoryOrder[catIdx]
		}
		return npcore.CategoryLogin
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
			ui.Text(signal.Func(func() string {
				if e.IsNew {
					return "新建加密条目"
				}
				return "编辑条目"
			}), ui.Style{
				Font:  fonts.Title2.Weighted(fonts.Bold),
				Color: colors.Label,
			}),
			ui.Row(ui.Style{Gap: 8},
				ui.Button(ui.ButtonProps{
					Title:   ui.Val("取消"),
					Variant: ui.ButtonBordered,
					OnPress: func() { s.editing.Set(false) },
				}),
				ui.Button(ui.ButtonProps{
					Title: signal.Func(func() string {
						if s.busy.Get() {
							return "正在加密保存..."
						}
						return "保存条目"
					}),
					Icon:     "checkmark",
					Variant:  ui.ButtonFilled,
					Disabled: s.busy,
					OnPress:  func() { s.SaveEditorItem() },
				}),
			),
		),

		ui.Show(signal.Func(func() bool { return e.Error.Get() != "" }), func() ui.Node {
			return ui.View(ui.ViewProps{
				Style: ui.Style{
					Padding:      ui.All(10),
					CornerRadius: 8,
					BorderWidth:  1,
					BorderColor:  colors.Red,
				},
			},
				ui.Text(e.Error, ui.Style{
					Font:  fonts.Footnote,
					Color: colors.Red,
				}),
			)
		}),

		// Basic Meta Card
		cardContainer("基本归属与类型",
			ui.Row(ui.Style{Gap: 12, Align: ui.AlignCenter},
				ui.Column(ui.Style{Grow: 1, Gap: 6},
					formLabel("所属密码库"),
					ui.Picker(ui.PickerProps{
						Items:    vaultNamesAcc,
						Selected: e.VaultIdx,
						Label:    ui.Val("选择密码库"),
						Disabled: ui.Val(!e.IsNew),
					}),
				),
				ui.Column(ui.Style{Grow: 1, Gap: 6},
					formLabel("条目类型"),
					ui.Picker(ui.PickerProps{
						Items:    ui.Val(categoryLabels),
						Selected: e.CategoryIdx,
						Label:    ui.Val("选择类型"),
					}),
				),
			),
			ui.Column(ui.Style{Gap: 6},
				formLabel("标题 *"),
				ui.TextField(ui.TextFieldProps{
					Value:       e.Title,
					Placeholder: ui.Val("例如 GitHub / 招商银行 Visa / 常用收货地址"),
				}),
			),
			ui.Row(ui.Style{Gap: 8, Align: ui.AlignCenter},
				ui.Toggle(ui.ToggleProps{
					Value:    e.Favorite,
					Checkbox: true,
				}),
				ui.StaticText("加入收藏夹", ui.Style{
					Font:  fonts.Footnote,
					Color: colors.Label,
				}),
			),
		),

		// Login / Credential Fields (shown for Login, API Credential, SSH Key, or when populated)
		ui.Show(signal.Func(func() bool {
			cat := isCardOrIdentity(e.CategoryIdx.Get())
			return cat == npcore.CategoryLogin || cat == npcore.CategoryAPICredential || cat == npcore.CategorySSHKey
		}), func() ui.Node {
			return cardContainer("账号与安全密钥",
				ui.Row(ui.Style{Gap: 12},
					ui.Column(ui.Style{Grow: 1, Gap: 6},
						formLabel("用户名 / 邮箱"),
						ui.TextField(ui.TextFieldProps{
							Value:       e.Username,
							Placeholder: ui.Val("name@example.com"),
						}),
					),
					ui.Column(ui.Style{Grow: 1, Gap: 6},
						formLabel("绑定掩码邮箱别名（可选）"),
						ui.TextField(ui.TextFieldProps{
							Value:       e.EmailAlias,
							Placeholder: ui.Val("github.x8f2a@mail.example.com"),
							Style:       ui.Style{Font: monoFont},
						}),
					),
				),
				ui.Column(ui.Style{Gap: 6},
					ui.Row(ui.Style{Justify: ui.JustifySpaceBetween, Align: ui.AlignCenter},
						formLabel("密码 / 密钥"),
						ui.Row(ui.Style{Gap: 6},
							ui.Button(ui.ButtonProps{
								Title:   ui.Val("随机强密码"),
								Variant: ui.ButtonBordered,
								OnPress: func() {
									if pw, err := npcore.GeneratePassword(20); err == nil {
										e.Password.Set(pw)
									}
								},
							}),
							ui.Button(ui.ButtonProps{
								Title:   ui.Val("易记短语"),
								Variant: ui.ButtonBordered,
								OnPress: func() {
									if pp, err := npcore.GeneratePassphrase(4); err == nil {
										e.Password.Set(pp)
									}
								},
							}),
						),
					),
					ui.TextField(ui.TextFieldProps{
						Value:       e.Password,
						Placeholder: ui.Val("输入密码或点击右上角由 Rust Core 随机生成"),
						Style:       ui.Style{Font: monoFont},
					}),
				),
				ui.Column(ui.Style{Gap: 6},
					formLabel("2FA TOTP 密钥或 otpauth:// URI"),
					ui.TextField(ui.TextFieldProps{
						Value:       e.TOTP,
						Placeholder: ui.Val("JBSWY3DPEHPK3PXP 或 otpauth://totp/..."),
						Style:       ui.Style{Font: monoFont},
					}),
				),
				ui.Column(ui.Style{Gap: 6},
					formLabel("关联网址 URL（每行一个，用于浏览器自动填充与邮箱验证码匹配）"),
					ui.TextField(ui.TextFieldProps{
						Value:       e.URLsText,
						Placeholder: ui.Val("https://github.com/login"),
						Multiline:   true,
						Style:       ui.Style{Lines: 3, Font: monoFont},
					}),
				),
			)
		}),

		// Credit Card Fields (shown when category == card)
		ui.Show(signal.Func(func() bool {
			return isCardOrIdentity(e.CategoryIdx.Get()) == npcore.CategoryCard
		}), func() ui.Node {
			return cardContainer("银行卡详情",
				ui.Row(ui.Style{Gap: 12},
					ui.Column(ui.Style{Grow: 1, Gap: 6},
						formLabel("持卡人姓名 (cardholderName)"),
						ui.TextField(ui.TextFieldProps{
							Value:       e.CardholderName,
							Placeholder: ui.Val("ZHANG SAN"),
						}),
					),
					ui.Column(ui.Style{Grow: 1, Gap: 6},
						formLabel("卡品牌 / 发卡组织 (brand)"),
						ui.TextField(ui.TextFieldProps{
							Value:       e.CardBrand,
							Placeholder: ui.Val("Visa / Mastercard / UnionPay"),
						}),
					),
				),
				ui.Column(ui.Style{Gap: 6},
					formLabel("银行卡号 (number)"),
					ui.TextField(ui.TextFieldProps{
						Value:       e.CardNumber,
						Placeholder: ui.Val("4111 2222 3333 4444"),
						Style:       ui.Style{Font: monoFont},
					}),
				),
				ui.Row(ui.Style{Gap: 12},
					ui.Column(ui.Style{Grow: 1, Gap: 6},
						formLabel("有效期月 (MM)"),
						ui.TextField(ui.TextFieldProps{
							Value:       e.CardExpMonth,
							Placeholder: ui.Val("08"),
							Style:       ui.Style{Font: monoFont},
						}),
					),
					ui.Column(ui.Style{Grow: 1, Gap: 6},
						formLabel("有效期年 (YYYY)"),
						ui.TextField(ui.TextFieldProps{
							Value:       e.CardExpYear,
							Placeholder: ui.Val("2029"),
							Style:       ui.Style{Font: monoFont},
						}),
					),
					ui.Column(ui.Style{Grow: 1, Gap: 6},
						formLabel("安全码 (CVV / CVC)"),
						ui.TextField(ui.TextFieldProps{
							Value:       e.CardCVV,
							Placeholder: ui.Val("123"),
							Secure:      true,
							Style:       ui.Style{Font: monoFont},
						}),
					),
				),
			)
		}),

		// Identity / Address Fields (shown when category == identity)
		ui.Show(signal.Func(func() bool {
			return isCardOrIdentity(e.CategoryIdx.Get()) == npcore.CategoryIdentity
		}), func() ui.Node {
			return cardContainer("身份与地址详情",
				ui.Row(ui.Style{Gap: 12},
					ui.Column(ui.Style{Grow: 1, Gap: 6},
						formLabel("姓名全称 (fullName)"),
						ui.TextField(ui.TextFieldProps{
							Value:       e.IDFullName,
							Placeholder: ui.Val("张三"),
						}),
					),
					ui.Column(ui.Style{Grow: 1, Gap: 6},
						formLabel("姓 (lastName)"),
						ui.TextField(ui.TextFieldProps{
							Value:       e.IDLastName,
							Placeholder: ui.Val("张"),
						}),
					),
					ui.Column(ui.Style{Grow: 1, Gap: 6},
						formLabel("名 (firstName)"),
						ui.TextField(ui.TextFieldProps{
							Value:       e.IDFirstName,
							Placeholder: ui.Val("三"),
						}),
					),
				),
				ui.Row(ui.Style{Gap: 12},
					ui.Column(ui.Style{Grow: 1, Gap: 6},
						formLabel("邮箱 (email)"),
						ui.TextField(ui.TextFieldProps{
							Value:       e.IDEmail,
							Placeholder: ui.Val("zhangsan@example.com"),
						}),
					),
					ui.Column(ui.Style{Grow: 1, Gap: 6},
						formLabel("手机 / 电话 (phone)"),
						ui.TextField(ui.TextFieldProps{
							Value:       e.IDPhone,
							Placeholder: ui.Val("+86 13800138000"),
							Style:       ui.Style{Font: monoFont},
						}),
					),
					ui.Column(ui.Style{Grow: 1, Gap: 6},
						formLabel("公司 / 组织 (company)"),
						ui.TextField(ui.TextFieldProps{
							Value:       e.IDCompany,
							Placeholder: ui.Val("公司名称（可选）"),
						}),
					),
				),
				ui.Column(ui.Style{Gap: 6},
					formLabel("街道地址行 1 (address1)"),
					ui.TextField(ui.TextFieldProps{
						Value:       e.IDAddress1,
						Placeholder: ui.Val("南山区科技园南区 8 栋"),
					}),
				),
				ui.Column(ui.Style{Gap: 6},
					formLabel("地址行 2 / 楼层门牌 (address2)"),
					ui.TextField(ui.TextFieldProps{
						Value:       e.IDAddress2,
						Placeholder: ui.Val("1201 室"),
					}),
				),
				ui.Row(ui.Style{Gap: 12},
					ui.Column(ui.Style{Grow: 1, Gap: 6},
						formLabel("国家 / 地区 (country)"),
						ui.TextField(ui.TextFieldProps{
							Value:       e.IDCountry,
							Placeholder: ui.Val("中国"),
						}),
					),
					ui.Column(ui.Style{Grow: 1, Gap: 6},
						formLabel("省 / 州 (state)"),
						ui.TextField(ui.TextFieldProps{
							Value:       e.IDState,
							Placeholder: ui.Val("广东省"),
						}),
					),
					ui.Column(ui.Style{Grow: 1, Gap: 6},
						formLabel("城市 (city)"),
						ui.TextField(ui.TextFieldProps{
							Value:       e.IDCity,
							Placeholder: ui.Val("深圳市"),
						}),
					),
					ui.Column(ui.Style{Grow: 1, Gap: 6},
						formLabel("邮编 (postalCode)"),
						ui.TextField(ui.TextFieldProps{
							Value:       e.IDPostalCode,
							Placeholder: ui.Val("518000"),
							Style:       ui.Style{Font: monoFont},
						}),
					),
				),
			)
		}),

		// Notes
		cardContainer("安全备注",
			ui.TextField(ui.TextFieldProps{
				Value:       e.Notes,
				Placeholder: ui.Val("恢复码、安全提示问题或补充说明..."),
				Multiline:   true,
				Style:       ui.Style{Lines: 4},
			}),
		),
	)
}

func formLabel(text string) ui.Node {
	return ui.StaticText(text, ui.Style{
		Font:  fonts.Footnote.Weighted(fonts.Medium),
		Color: colors.SecondaryLabel,
	})
}
