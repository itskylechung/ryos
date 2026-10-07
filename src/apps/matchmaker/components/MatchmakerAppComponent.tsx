import { useCallback, useEffect, useMemo, useState } from "react";
import { useTranslation } from "react-i18next";
import { useChat } from "@ai-sdk/react";
import { DefaultChatTransport } from "ai";
import { AppProps } from "@/apps/base/types";
import { AppWindowShell } from "@/components/shared/AppWindowShell";
import { AppHelpAboutDialogs } from "@/components/shared/AppHelpAboutDialogs";
import { ThemedTabsList, ThemedTabsTrigger } from "@/components/shared/ThemedTabs";
import { Tabs, TabsContent } from "@/components/ui/tabs";
import { Button } from "@/components/ui/button";
import { OsTextarea } from "@/components/ui/os-textarea";
import { Input } from "@/components/ui/input";
import { EmptyState } from "@/components/ui/empty-state";
import { useThemeFlags } from "@/hooks/useThemeFlags";
import { useTranslatedHelpItems } from "@/hooks/useTranslatedHelpItems";
import { useChatsStore } from "@/stores/useChatsStore";
import { getApiUrl } from "@/utils/platform";
import { getTranslatedAppName } from "@/utils/i18n";
import { openChatRoomFromNotification } from "@/utils/openChatRoomFromNotification";
import {
  getMatchDrop,
  getMatchProfile,
  leaveMatchmaker,
  respondToMatchDrop,
  updateMatchProfile,
  type MatchDrop,
  type MatchProfile,
} from "@/api/matchmaker";
import { appMetadata, helpItems } from "..";
import { MatchmakerMenuBar } from "./MatchmakerMenuBar";

type Tab = "week" | "profile" | "interview";

export function MatchmakerAppComponent({
  isWindowOpen,
  onClose,
  isForeground,
  skipInitialSound,
  instanceId,
  onNavigateNext,
  onNavigatePrevious,
}: AppProps) {
  const { t } = useTranslation();
  const { isWindowsTheme } = useThemeFlags();
  const translatedHelpItems = useTranslatedHelpItems("matchmaker", helpItems);
  const [isHelpOpen, setIsHelpOpen] = useState(false);
  const [isAboutOpen, setIsAboutOpen] = useState(false);

  const isAuthenticated = useChatsStore((s) => s.isAuthenticated);
  const [tab, setTab] = useState<Tab>("week");
  const [profile, setProfile] = useState<MatchProfile | null>(null);
  const [drop, setDrop] = useState<MatchDrop | null>(null);
  const [draftText, setDraftText] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const refresh = useCallback(async () => {
    if (!isAuthenticated) return;
    try {
      const [p, d] = await Promise.all([getMatchProfile(), getMatchDrop()]);
      setProfile(p.profile);
      setDraftText(p.profile.draft ?? p.profile.approved ?? "");
      setDrop(d.drop);
      setError(null);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    }
  }, [isAuthenticated]);

  useEffect(() => {
    if (isWindowOpen) void refresh();
  }, [isWindowOpen, refresh]);

  const run = async (fn: () => Promise<void>) => {
    setBusy(true);
    setError(null);
    try {
      await fn();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  };

  const transport = useMemo(
    () =>
      new DefaultChatTransport({
        api: getApiUrl("/api/matchmaker/chat"),
        credentials: "include",
      }),
    []
  );
  const { messages, sendMessage, status } = useChat({
    transport,
    // The agent saves drafts via a tool — pull the latest into the Profile tab.
    onFinish: () => void refresh(),
  });
  const [input, setInput] = useState("");
  const chatBusy = status === "submitted" || status === "streaming";
  const send = (text: string) => {
    if (!text.trim() || chatBusy) return;
    void sendMessage({ text });
    setInput("");
  };

  const menuBar = (
    <MatchmakerMenuBar
      onClose={onClose}
      onShowHelp={() => setIsHelpOpen(true)}
      onShowAbout={() => setIsAboutOpen(true)}
      onRefresh={() => void refresh()}
    />
  );

  const renderWeek = () => {
    if (drop) {
      const matched = drop.roomId !== null;
      return (
        <div className="flex flex-col gap-2">
          <div className="font-bold">
            {t("apps.matchmaker.week.meet", { username: drop.partner })}
          </div>
          <p className="whitespace-pre-wrap">{drop.partnerProfile}</p>
          <div className="border-t border-black/20 pt-2">
            <div className="font-bold">{t("apps.matchmaker.week.why")}</div>
            <p>{drop.why}</p>
          </div>
          <div>
            <div className="font-bold">{t("apps.matchmaker.week.opener")}</div>
            <p className="italic">“{drop.opener}”</p>
          </div>
          {matched ? (
            <Button onClick={() => openChatRoomFromNotification(drop.roomId)}>
              {t("apps.matchmaker.week.openChat")}
            </Button>
          ) : drop.myResponse === "pending" ? (
            <div className="flex gap-1.5">
              <Button disabled={busy} onClick={() => run(async () => setDrop((await respondToMatchDrop("accept")).drop))}>
                {t("apps.matchmaker.week.accept")}
              </Button>
              <Button variant="secondary" disabled={busy} onClick={() => run(async () => setDrop((await respondToMatchDrop("decline")).drop))}>
                {t("apps.matchmaker.week.pass")}
              </Button>
              <Button variant="destructive" disabled={busy} onClick={() => run(async () => setDrop((await respondToMatchDrop("block")).drop))}>
                {t("apps.matchmaker.week.block")}
              </Button>
            </div>
          ) : (
            <div className="text-neutral-500">
              {drop.myResponse === "declined"
                ? t("apps.matchmaker.week.youPassed")
                : drop.partnerResponse === "declined"
                  ? t("apps.matchmaker.week.theyPassed")
                  : t("apps.matchmaker.week.waiting")}
            </div>
          )}
        </div>
      );
    }
    if (!profile || profile.status === "none") {
      return (
        <div className="flex flex-col items-center gap-2 py-6 text-center">
          <p>{t("apps.matchmaker.week.intro")}</p>
          <Button onClick={() => setTab("interview")}>
            {t("apps.matchmaker.week.start")}
          </Button>
        </div>
      );
    }
    return (
      <EmptyState
        message={
          profile.status === "paused"
            ? t("apps.matchmaker.week.paused")
            : t("apps.matchmaker.week.inPool")
        }
      />
    );
  };

  const renderProfile = () => (
    <div className="flex flex-col gap-2">
      <p className="text-neutral-500">{t("apps.matchmaker.profile.hint")}</p>
      <OsTextarea
        value={draftText}
        onChange={(e) => setDraftText(e.target.value)}
        maxLength={600}
        rows={6}
        placeholder={t("apps.matchmaker.profile.placeholder")}
      />
      {profile && profile.tags.length > 0 && (
        <div className="text-neutral-500">{profile.tags.join(" · ")}</div>
      )}
      <div className="flex flex-wrap gap-1.5">
        <Button
          disabled={busy || draftText.trim().length < 20}
          onClick={() => run(async () => setProfile((await updateMatchProfile({ action: "approve", text: draftText })).profile))}
        >
          {profile?.approved && profile.approved === draftText.trim()
            ? t("apps.matchmaker.profile.approved")
            : t("apps.matchmaker.profile.approve")}
        </Button>
        {profile?.status === "active" && (
          <Button variant="secondary" disabled={busy} onClick={() => run(async () => setProfile((await updateMatchProfile({ action: "pause" })).profile))}>
            {t("apps.matchmaker.profile.pause")}
          </Button>
        )}
        {profile?.status === "paused" && (
          <Button variant="secondary" disabled={busy} onClick={() => run(async () => setProfile((await updateMatchProfile({ action: "resume" })).profile))}>
            {t("apps.matchmaker.profile.resume")}
          </Button>
        )}
        {profile && profile.status !== "none" && (
          <Button
            variant="destructive"
            disabled={busy}
            onClick={() =>
              run(async () => {
                await leaveMatchmaker();
                await refresh();
              })
            }
          >
            {t("apps.matchmaker.profile.leave")}
          </Button>
        )}
      </div>
    </div>
  );

  const renderInterview = () => (
    <div className="flex h-full min-h-0 flex-col gap-2">
      <div className="flex-1 min-h-0 overflow-y-auto flex flex-col gap-2">
        {messages.length === 0 && (
          <div className="flex flex-col items-center gap-2 py-6 text-center">
            <p>{t("apps.matchmaker.interview.intro")}</p>
            <Button onClick={() => send(t("apps.matchmaker.interview.kickoff"))}>
              {t("apps.matchmaker.interview.begin")}
            </Button>
          </div>
        )}
        {messages.map((m) => (
          <div key={m.id} className={m.role === "user" ? "self-end text-right" : "self-start"}>
            {m.parts.map((part, i) =>
              part.type === "text" ? (
                <p key={i} className="whitespace-pre-wrap">
                  {m.role === "assistant" && <b>ryo: </b>}
                  {part.text}
                </p>
              ) : part.type === "tool-saveMatchProfileDraft" ? (
                <p key={i} className="text-neutral-500 italic">
                  {t("apps.matchmaker.interview.draftSaved")}
                </p>
              ) : null
            )}
          </div>
        ))}
        {chatBusy && <p className="text-neutral-500">…</p>}
      </div>
      <form
        className="flex gap-1.5"
        onSubmit={(e) => {
          e.preventDefault();
          send(input);
        }}
      >
        <Input
          className="flex-1"
          value={input}
          onChange={(e) => setInput(e.target.value)}
          placeholder={t("apps.matchmaker.interview.placeholder")}
        />
        <Button type="submit" disabled={chatBusy || !input.trim()}>
          {t("apps.matchmaker.interview.send")}
        </Button>
      </form>
    </div>
  );

  return (
    <AppWindowShell
      isWindowOpen={isWindowOpen}
      isWindowsTheme={isWindowsTheme}
      isForeground={isForeground}
      menuBar={menuBar}
      trailing={
        <AppHelpAboutDialogs
          appId="matchmaker"
          metadata={appMetadata}
          helpItems={translatedHelpItems}
          isHelpOpen={isHelpOpen}
          onHelpOpenChange={setIsHelpOpen}
          isAboutOpen={isAboutOpen}
          onAboutOpenChange={setIsAboutOpen}
        />
      }
      windowFrameProps={{
        title: getTranslatedAppName("matchmaker"),
        onClose,
        isForeground,
        appId: "matchmaker",
        skipInitialSound,
        instanceId,
        onNavigateNext,
        onNavigatePrevious,
      }}
    >
      <div className="flex h-full min-h-0 flex-col bg-white p-3 text-[12px] font-geneva-12">
        {!isAuthenticated ? (
          <EmptyState message={t("apps.matchmaker.signIn")} className="flex-1" />
        ) : (
          <Tabs
            value={tab}
            onValueChange={(v) => setTab(v as Tab)}
            className="flex h-full min-h-0 flex-col"
          >
            <ThemedTabsList className="grid w-full grid-cols-3">
              <ThemedTabsTrigger value="week">{t("apps.matchmaker.tabs.week")}</ThemedTabsTrigger>
              <ThemedTabsTrigger value="profile">{t("apps.matchmaker.tabs.profile")}</ThemedTabsTrigger>
              <ThemedTabsTrigger value="interview">{t("apps.matchmaker.tabs.interview")}</ThemedTabsTrigger>
            </ThemedTabsList>
            {error && <p className="mt-2 text-red-600">{error}</p>}
            <TabsContent value="week" className="mt-2 flex-1 min-h-0 overflow-y-auto">
              {renderWeek()}
            </TabsContent>
            <TabsContent value="profile" className="mt-2 flex-1 min-h-0 overflow-y-auto">
              {renderProfile()}
            </TabsContent>
            <TabsContent value="interview" className="mt-2 flex-1 min-h-0">
              {renderInterview()}
            </TabsContent>
          </Tabs>
        )}
      </div>
    </AppWindowShell>
  );
}
