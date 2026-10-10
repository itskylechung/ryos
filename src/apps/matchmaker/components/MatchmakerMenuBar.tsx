import { AppMenuBarShell } from "@/components/shared/menubar/AppMenuBarShell";
import {
  AppMenuBarMenus,
  type MenuDescriptor,
} from "@/components/shared/menubar/AppMenuBarMenus";
import { useAppMenuBarChrome } from "@/hooks/useAppMenuBarChrome";
import { useTranslation } from "react-i18next";

interface MatchmakerMenuBarProps {
  onClose: () => void;
  onShowHelp: () => void;
  onShowAbout: () => void;
  onRefresh: () => void;
}

export function MatchmakerMenuBar({
  onClose,
  onShowHelp,
  onShowAbout,
  onRefresh,
}: MatchmakerMenuBarProps) {
  const { t } = useTranslation();
  const chrome = useAppMenuBarChrome("matchmaker");

  const menus: MenuDescriptor[] = [
    {
      label: t("common.menu.file"),
      items: [
        {
          type: "action",
          label: t("apps.matchmaker.menu.refresh"),
          onClick: onRefresh,
        },
        { type: "separator" },
        {
          type: "action",
          label: t("common.menu.close"),
          onClick: onClose,
          shortcutId: "close",
        },
      ],
    },
  ];

  return (
    <AppMenuBarShell
      isWindowsTheme={chrome.isWindowsTheme}
      isMacOSTheme={chrome.isMacOSTheme}
      appId={chrome.appId}
      appName={chrome.appName}
      isShareDialogOpen={chrome.isShareDialogOpen}
      setIsShareDialogOpen={chrome.setIsShareDialogOpen}
      helpItemLabel={t("apps.matchmaker.menu.help")}
      aboutItemLabel={t("apps.matchmaker.menu.about")}
      onShowHelp={onShowHelp}
      onShowAbout={onShowAbout}
    >
      <AppMenuBarMenus menus={menus} />
    </AppMenuBarShell>
  );
}
