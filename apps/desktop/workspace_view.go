package main

import (
	"fmt"

	"github.com/egoist/asuka/colors"
	"github.com/egoist/asuka/fonts"
	"github.com/egoist/asuka/signal"
	"github.com/egoist/asuka/ui"

	"desktop/client"
	"desktop/npcore"
)

func WorkspaceView(s *AppState) ui.Node {
	return ui.Row(ui.Style{
		Grow:       1,
		Background: colors.Background,
	},
		SidebarPane(s),
		// Vertical divider
		ui.View(ui.ViewProps{
			Style: ui.Style{
				Width:      ui.Pt(1),
				Background: colors.Separator,
			},
		}),
		ui.Column(ui.Style{Grow: 1},
			StatusBannerBar(s),
			ui.Show(
				signal.Func(func() bool { return s.section.Get() == SectionEmails }),
				func() ui.Node { return EmailOTPView(s) },
				func() ui.Node {
					return ui.Row(ui.Style{Grow: 1},
						ItemListPane(s),
						ui.View(ui.ViewProps{
							Style: ui.Style{
								Width:      ui.Pt(1),
								Background: colors.Separator,
							},
						}),
						ui.Show(
							s.editing,
							func() ui.Node { return ItemEditorView(s) },
							func() ui.Node { return ItemDetailView(s) },
						),
					)
				},
			),
		),
	)
}

func StatusBannerBar(s *AppState) ui.Node {
	return ui.Show(
		signal.Func(func() bool {
			return s.clipRemaining.Get() > 0 || s.statusBanner.Get() != ""
		}),
		func() ui.Node {
			return ui.Column(ui.Style{},
				ui.Row(ui.Style{
					Padding:    ui.Symmetric(8, 16),
					Align:      ui.AlignCenter,
					Justify:    ui.JustifySpaceBetween,
					Background: colors.SecondaryBackground,
				},
					ui.Row(ui.Style{Gap: 8, Align: ui.AlignCenter},
						ui.Symbol("checkmark.shield.fill", ui.Style{
							Font:  fonts.Footnote,
							Color: colors.Green,
						}),
						ui.Text(signal.Func(func() string {
							msg := s.statusBanner.Get()
							rem := s.clipRemaining.Get()
							if rem > 0 {
								return fmt.Sprintf("%s · %ds 后自动清空剪贴板", msg, rem)
							}
							return msg
						}), ui.Style{
							Font:  fonts.Footnote,
							Color: colors.Label,
						}),
					),
					ui.Row(ui.Style{Gap: 8, Align: ui.AlignCenter},
						ui.Show(signal.Func(func() bool { return s.clipRemaining.Get() > 0 }), func() ui.Node {
							return ui.Button(ui.ButtonProps{
								Title:   ui.Val("立即清空剪贴板"),
								Variant: ui.ButtonBordered,
								OnPress: func() { s.ClearClipboardNow() },
							})
						}),
						ui.Button(ui.ButtonProps{
							Title:   ui.Val("关闭"),
							Variant: ui.ButtonPlain,
							OnPress: func() { s.statusBanner.Set("") },
						}),
					),
				),
				ui.View(ui.ViewProps{
					Style: ui.Style{Height: ui.Pt(1), Background: colors.Separator},
				}),
			)
		},
	)
}

func SidebarPane(s *AppState) ui.Node {
	return ui.Column(ui.Style{
		Width:      ui.Pt(225),
		Shrink:     ui.NoShrink,
		Background: colors.SecondaryBackground,
		Padding:    ui.All(12),
		Gap:        12,
	},
		// Account & WebSocket status header
		ui.Column(ui.Style{
			Padding:      ui.All(10),
			Gap:          4,
			Background:   colors.Background,
			CornerRadius: 10,
			BorderWidth:  1,
			BorderColor:  colors.Separator,
		},
			ui.Row(ui.Style{Align: ui.AlignCenter, Gap: 8},
				ui.Symbol("lock.shield.fill", ui.Style{
					Font:  fonts.Headline,
					Color: colors.Accent,
				}),
				ui.StaticText("NonePwd", ui.Style{
					Font:  fonts.Headline.Weighted(fonts.Semibold),
					Color: colors.Label,
				}),
			),
			ui.Text(s.accountEmail, ui.Style{
				Font:  fonts.Caption,
				Color: colors.SecondaryLabel,
				Lines: 1,
			}),
			ui.Row(ui.Style{Align: ui.AlignCenter, Gap: 6},
				ui.View(ui.ViewProps{
					Style: ui.StyleFunc(func() ui.Style {
						dotColor := colors.Orange
						if s.wsConnected.Get() {
							dotColor = colors.Green
						}
						return ui.Style{
							Width:        ui.Pt(7),
							Height:       ui.Pt(7),
							CornerRadius: 4,
							Background:   dotColor,
						}
					}),
				}),
				ui.Text(signal.Func(func() string {
					if s.wsConnected.Get() {
						return "WebSocket 实时推送已连接"
					}
					return "实时通道重连中..."
				}), ui.Style{
					Font:  fonts.Caption2,
					Color: colors.SecondaryLabel,
				}),
			),
		),

		// Scrollable Navigation Sections
		ui.Scroll(ui.ScrollProps{
			Style:        ui.Style{Grow: 1},
			ContentStyle: ui.Style{Gap: 14},
		},
			// Category section
			ui.Column(ui.Style{Gap: 3},
				ui.StaticText("凭据分类", ui.Style{
					Font:    fonts.Caption.Weighted(fonts.Semibold),
					Color:   colors.SecondaryLabel,
					Padding: ui.Symmetric(2, 6),
				}),
				sidebarNavRow(s, SectionAll, "tray.full.fill", "全部条目", func() string {
					return fmt.Sprintf("%d", len(s.items.Get()))
				}),
				sidebarNavRow(s, SectionFavorite, "star.fill", "收藏夹", func() string {
					n := 0
					for _, it := range s.items.Get() {
						if it.Favorite {
							n++
						}
					}
					if n == 0 {
						return ""
					}
					return fmt.Sprintf("%d", n)
				}),
				sidebarNavRow(s, SectionLogin, "globe", "网站登录", nil),
				sidebarNavRow(s, SectionCard, "creditcard.fill", "银行卡", nil),
				sidebarNavRow(s, SectionIdentity, "person.text.rectangle.fill", "身份地址", nil),
				sidebarNavRow(s, SectionDev, "key.fill", "密钥与笔记", nil),
				sidebarNavRow(s, SectionEmails, "envelope.badge.shield.half.filled", "邮箱验证码", func() string {
					n := len(s.emails.Get())
					if n == 0 {
						return ""
					}
					return fmt.Sprintf("%d", n)
				}),
			),

			// Vaults section
			ui.Column(ui.Style{Gap: 3},
				ui.Row(ui.Style{
					Justify: ui.JustifySpaceBetween,
					Align:   ui.AlignCenter,
					Padding: ui.Symmetric(2, 6),
				},
					ui.StaticText("密码库", ui.Style{
						Font:  fonts.Caption.Weighted(fonts.Semibold),
						Color: colors.SecondaryLabel,
					}),
					ui.Button(ui.ButtonProps{
						Title:   ui.Val("+ 新建"),
						Variant: ui.ButtonPlain,
						OnPress: func() { s.PromptCreateVault() },
					}),
				),
				vaultFilterRow(s, "all", "所有密码库"),
				ui.For(
					s.vaults,
					func(v client.DecryptedVault) string { return v.ID },
					func(vAcc signal.Accessor[client.DecryptedVault], _ signal.Accessor[int]) ui.Node {
						v := signal.Untrack(vAcc.Get)
						return vaultItemDynamicRow(s, vAcc, v.ID)
					},
				),
			),
		),

		// Bottom toolbar: Sync & Lock
		ui.Row(ui.Style{Gap: 8},
			ui.Button(ui.ButtonProps{
				Title:   ui.Val("同步"),
				Icon:    "arrow.clockwise",
				Variant: ui.ButtonBordered,
				Style:   ui.Style{Grow: 1},
				OnPress: func() { s.RefreshSync() },
			}),
			ui.Button(ui.ButtonProps{
				Title:   ui.Val("锁定"),
				Icon:    "lock.fill",
				Variant: ui.ButtonTinted,
				Style:   ui.Style{Grow: 1},
				OnPress: func() { s.LockVault() },
			}),
		),
	)
}

func sidebarNavRow(s *AppState, target FilterSection, icon ui.Icon, label string, countFn func() string) ui.Node {
	return ui.View(ui.ViewProps{
		OnPress: func() {
			s.editing.Set(false)
			s.section.Set(target)
		},
		Style: ui.StyleFunc(func() ui.Style {
			active := s.section.Get() == target
			bg := colors.Clear
			if active {
				bg = colors.Accent
			}
			return ui.Style{
				Direction:    ui.RowDir,
				Align:        ui.AlignCenter,
				Justify:      ui.JustifySpaceBetween,
				Padding:      ui.Symmetric(7, 10),
				CornerRadius: 8,
				Background:   bg,
				Hovered: &ui.Style{
					Background: func() ui.Color {
						if active {
							return colors.Accent
						}
						return colors.GroupedBackground
					}(),
				},
			}
		}),
	},
		ui.Row(ui.Style{Align: ui.AlignCenter, Gap: 8},
			ui.Symbol(icon, ui.StyleFunc(func() ui.Style {
				c := colors.SecondaryLabel
				if s.section.Get() == target {
					c = colors.OnAccent
				}
				return ui.Style{Font: fonts.Subheadline, Color: c}
			})),
			ui.Text(ui.Val(label), ui.StyleFunc(func() ui.Style {
				c := colors.Label
				w := fonts.Regular
				if s.section.Get() == target {
					c = colors.OnAccent
					w = fonts.Semibold
				}
				return ui.Style{Font: fonts.Subheadline.Weighted(w), Color: c}
			})),
		),
		ui.Show(
			signal.Func(func() bool {
				return countFn != nil && countFn() != ""
			}),
			func() ui.Node {
				return ui.Text(signal.Func(func() string {
					if countFn == nil {
						return ""
					}
					return countFn()
				}), ui.StyleFunc(func() ui.Style {
					c := colors.SecondaryLabel
					if s.section.Get() == target {
						c = colors.OnAccent
					}
					return ui.Style{Font: fonts.Caption, Color: c}
				}))
			},
		),
	)
}

func vaultFilterRow(s *AppState, vaultID, title string) ui.Node {
	return ui.View(ui.ViewProps{
		OnPress: func() {
			s.selectedVaultID.Set(vaultID)
			if s.section.Peek() == SectionEmails {
				s.section.Set(SectionAll)
			}
		},
		Style: ui.StyleFunc(func() ui.Style {
			active := s.selectedVaultID.Get() == vaultID && s.section.Get() != SectionEmails
			bg := colors.Clear
			if active {
				bg = colors.GroupedBackground
			}
			return ui.Style{
				Direction:    ui.RowDir,
				Align:        ui.AlignCenter,
				Gap:          8,
				Padding:      ui.Symmetric(6, 10),
				CornerRadius: 8,
				Background:   bg,
			}
		}),
	},
		ui.Symbol("folder.fill", ui.StyleFunc(func() ui.Style {
			c := colors.SecondaryLabel
			if s.selectedVaultID.Get() == vaultID && s.section.Get() != SectionEmails {
				c = colors.Accent
			}
			return ui.Style{Font: fonts.Footnote, Color: c}
		})),
		ui.Text(ui.Val(title), ui.StyleFunc(func() ui.Style {
			w := fonts.Regular
			if s.selectedVaultID.Get() == vaultID && s.section.Get() != SectionEmails {
				w = fonts.Semibold
			}
			return ui.Style{
				Font:  fonts.Footnote.Weighted(w),
				Color: colors.Label,
				Lines: 1,
				Grow:  1,
			}
		})),
	)
}

func vaultItemDynamicRow(s *AppState, vAcc signal.Accessor[client.DecryptedVault], vaultID string) ui.Node {
	return ui.View(ui.ViewProps{
		OnPress: func() {
			s.selectedVaultID.Set(vaultID)
			if s.section.Peek() == SectionEmails {
				s.section.Set(SectionAll)
			}
		},
		Style: ui.StyleFunc(func() ui.Style {
			active := s.selectedVaultID.Get() == vaultID && s.section.Get() != SectionEmails
			bg := colors.Clear
			if active {
				bg = colors.GroupedBackground
			}
			return ui.Style{
				Direction:    ui.RowDir,
				Align:        ui.AlignCenter,
				Gap:          8,
				Padding:      ui.Symmetric(6, 10),
				CornerRadius: 8,
				Background:   bg,
			}
		}),
	},
		ui.Symbol("lock.doc.fill", ui.StyleFunc(func() ui.Style {
			c := colors.SecondaryLabel
			if s.selectedVaultID.Get() == vaultID && s.section.Get() != SectionEmails {
				c = colors.Accent
			}
			return ui.Style{Font: fonts.Footnote, Color: c}
		})),
		ui.Text(signal.Func(func() string {
			return vAcc.Get().Metadata.Name
		}), ui.StyleFunc(func() ui.Style {
			w := fonts.Regular
			if s.selectedVaultID.Get() == vaultID && s.section.Get() != SectionEmails {
				w = fonts.Semibold
			}
			return ui.Style{
				Font:  fonts.Footnote.Weighted(w),
				Color: colors.Label,
				Lines: 1,
				Grow:  1,
			}
		})),
	)
}

func ItemListPane(s *AppState) ui.Node {
	filteredAcc := signal.Func(func() []npcore.VaultItemPayload {
		return s.FilteredItems(s.items.Get(), s.selectedVaultID.Get(), s.section.Get(), s.searchQuery.Get())
	})

	return ui.Column(ui.Style{
		Width:      ui.Pt(305),
		Shrink:     ui.NoShrink,
		Background: colors.Background,
	},
		// Search + Create toolbar
		ui.Column(ui.Style{
			Padding: ui.All(12),
			Gap:     8,
		},
			ui.Row(ui.Style{Gap: 8, Align: ui.AlignCenter},
				ui.TextField(ui.TextFieldProps{
					Value:       s.searchQuery,
					Placeholder: ui.Val("搜索标题、用户名、网址、卡号..."),
					Style:       ui.Style{Grow: 1},
				}),
				ui.Button(ui.ButtonProps{
					Title:   ui.Val("新建"),
					Icon:    "plus",
					Variant: ui.ButtonFilled,
					OnPress: func() { s.OpenCreateEditor() },
				}),
			),
			ui.Row(ui.Style{Justify: ui.JustifySpaceBetween, Align: ui.AlignCenter},
				ui.Text(signal.Func(func() string {
					return fmt.Sprintf("共 %d 项凭据", len(filteredAcc.Get()))
				}), ui.Style{
					Font:  fonts.Caption,
					Color: colors.SecondaryLabel,
				}),
				ui.Show(signal.Func(func() bool { return s.searchQuery.Get() != "" }), func() ui.Node {
					return ui.Button(ui.ButtonProps{
						Title:   ui.Val("清除搜索"),
						Variant: ui.ButtonPlain,
						OnPress: func() { s.searchQuery.Set("") },
					})
				}),
			),
		),
		ui.View(ui.ViewProps{
			Style: ui.Style{Height: ui.Pt(1), Background: colors.Separator},
		}),

		// Items scroll list
		ui.Show(
			signal.Func(func() bool { return len(filteredAcc.Get()) == 0 }),
			func() ui.Node {
				return ui.Column(ui.Style{
					Grow:    1,
					Justify: ui.JustifyCenter,
					Align:   ui.AlignCenter,
					Padding: ui.All(24),
					Gap:     10,
				},
					ui.Symbol("tray", ui.Style{
						Font:  fonts.LargeTitle,
						Color: colors.TertiaryLabel,
					}),
					ui.StaticText("当前筛选下暂无凭据", ui.Style{
						Font:  fonts.Subheadline.Weighted(fonts.Medium),
						Color: colors.SecondaryLabel,
					}),
					ui.Button(ui.ButtonProps{
						Title:   ui.Val("新建第一条凭据"),
						Variant: ui.ButtonTinted,
						OnPress: func() { s.OpenCreateEditor() },
					}),
				)
			},
			func() ui.Node {
				return ui.Scroll(ui.ScrollProps{
					Style:        ui.Style{Grow: 1},
					ContentStyle: ui.Style{Padding: ui.All(8), Gap: 4},
				},
					ui.For(
						filteredAcc,
						func(it npcore.VaultItemPayload) string { return it.ID },
						func(itAcc signal.Accessor[npcore.VaultItemPayload], _ signal.Accessor[int]) ui.Node {
							itemID := signal.Untrack(itAcc.Get).ID
							return itemListRow(s, itAcc, itemID)
						},
					),
				)
			},
		),
	)
}

func itemListRow(s *AppState, itAcc signal.Accessor[npcore.VaultItemPayload], itemID string) ui.Node {
	return ui.View(ui.ViewProps{
		OnPress: func() { s.SelectItem(itemID) },
		Style: ui.StyleFunc(func() ui.Style {
			activeItem := s.ActiveItemGet()
			selected := activeItem != nil && activeItem.ID == itemID && !s.editing.Get()
			bg := colors.Clear
			border := colors.Clear
			if selected {
				bg = colors.SecondaryGroupedBackground
				border = colors.Accent
			}
			return ui.Style{
				Direction:    ui.RowDir,
				Align:        ui.AlignCenter,
				Gap:          10,
				Padding:      ui.All(10),
				CornerRadius: 10,
				Background:   bg,
				BorderWidth:  1,
				BorderColor:  border,
				Hovered: &ui.Style{
					Background: colors.SecondaryGroupedBackground,
				},
			}
		}),
	},
		ui.Dynamic(func() ui.Node {
			it := itAcc.Get()
			return ui.View(ui.ViewProps{
				Style: ui.Style{
					Width:        ui.Pt(34),
					Height:       ui.Pt(34),
					CornerRadius: 8,
					Background:   colors.SecondaryBackground,
					Justify:      ui.JustifyCenter,
					Align:        ui.AlignCenter,
					Shrink:       ui.NoShrink,
				},
			},
				ui.Symbol(CategoryIcon(it.Category), ui.Style{
					Font:  fonts.Subheadline,
					Color: colors.Accent,
				}),
			)
		}),
		ui.Column(ui.Style{Grow: 1, Gap: 2},
			ui.Row(ui.Style{Align: ui.AlignCenter, Justify: ui.JustifySpaceBetween, Gap: 6},
				ui.Text(signal.Func(func() string {
					return itAcc.Get().Title
				}), ui.Style{
					Font:  fonts.Subheadline.Weighted(fonts.Semibold),
					Color: colors.Label,
					Lines: 1,
					Grow:  1,
				}),
				ui.Show(signal.Func(func() bool { return itAcc.Get().TOTP != "" }), func() ui.Node {
					return ui.StaticText("2FA", ui.Style{
						Font:  fonts.Caption2.Weighted(fonts.Semibold),
						Color: colors.Accent,
					})
				}),
				ui.Show(signal.Func(func() bool { return itAcc.Get().Favorite }), func() ui.Node {
					return ui.Symbol("star.fill", ui.Style{
						Font:  fonts.Caption2,
						Color: colors.Orange,
					})
				}),
			),
			ui.Text(signal.Func(func() string {
				return ItemSubtitle(itAcc.Get())
			}), ui.Style{
				Font:  fonts.Caption,
				Color: colors.SecondaryLabel,
				Lines: 1,
			}),
		),
	)
}
