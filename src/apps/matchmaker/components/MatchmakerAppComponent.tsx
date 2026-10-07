import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { useChat, type UIMessage } from "@ai-sdk/react";
import { DefaultChatTransport } from "ai";
import { AppProps } from "@/apps/base/types";
import { AppWindowShell } from "@/components/shared/AppWindowShell";
import { AppHelpAboutDialogs } from "@/components/shared/AppHelpAboutDialogs";
import { osAppSidebarSurfaceClassName } from "@/components/shared/osThemePrimitives";
import { Button } from "@/components/ui/button";
import { OsTextarea } from "@/components/ui/os-textarea";
import { EmptyState } from "@/components/ui/empty-state";
// Reuse Chats' message list + input so the interview looks and behaves like
// talking to Ryo in Chats (bubbles, tool status rows, speech, theming).
import { ChatMessages } from "@/apps/chats/components/ChatMessages";
import { ChatInput } from "@/apps/chats/components/ChatInput";
import type { ChatMessage } from "@/apps/chats/components/chat-messages/types";
import { useChatSpeechSync } from "@/apps/chats/hooks/useChatSpeechSync";
import type { AIChatMessage } from "@/types/chat";
import { useThemeFlags } from "@/hooks/useThemeFlags";
import { useTranslatedHelpItems } from "@/hooks/useTranslatedHelpItems";
import { useChatsStore } from "@/stores/useChatsStore";
import { getApiUrl } from "@/utils/platform";
import { getTranslatedAppName } from "@/utils/i18n";
import { openChatRoomFromNotification } from "@/utils/openChatRoomFromNotification";
import { cn } from "@/lib/utils";
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

type Pane = "ryo" | "week" | "profile";

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
  const { isWindowsTheme, isMacOSTheme, isAquaGlass } = useThemeFlags();
  const translatedHelpItems = useTranslatedHelpItems("matchmaker", helpItems);
  const [isHelpOpen, setIsHelpOpen] = useState(false);
  const [isAboutOpen, setIsAboutOpen] = useState(false);

  const isAuthenticated = useChatsStore((s) => s.isAuthenticated);
  const username = useChatsStore((s) => s.username);
  const rooms = useChatsStore((s) => s.rooms);
  const fontSize = useChatsStore((s) => s.fontSize);

  const [pane, setPane] = useState<Pane>("week");
  const [profile, setProfile] = useState<MatchProfile | null>(null);
  const [drop, setDrop] = useState<MatchDrop | null>(null);
  const [past, setPast] = useState<string[]>([]);
  const [draftText, setDraftText] = useState("");
  // Unsaved edits in the Profile textarea win over server refreshes (e.g. the
  // one after each interview turn) until the user approves.
  const draftDirtyRef = useRef(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const refresh = useCallback(async () => {
    if (!isAuthenticated) return;
    try {
      const [p, d] = await Promise.all([getMatchProfile(), getMatchDrop()]);
      setProfile(p.profile);
      if (!draftDirtyRef.current) {
        setDraftText(p.profile.draft ?? p.profile.approved ?? "");
      }
      setDrop(d.drop);
      setPast(d.past);
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

  // Past matches = private 1:1 rooms with someone Ryo matched you with.
  const matchRooms = useMemo(() => {
    const me = username?.toLowerCase();
    const partners = new Set(past);
    return (rooms ?? []).filter(
      (room) =>
        room.type === "private" &&
        room.members?.length === 2 &&
        room.members.some((m) => m !== me && partners.has(m))
    );
  }, [rooms, past, username]);

  // ---- Interview (Ryo) --------------------------------------------------
  const transport = useMemo(
    () =>
      new DefaultChatTransport({
        api: getApiUrl("/api/matchmaker/chat"),
        credentials: "include",
      }),
    []
  );
  const { messages, sendMessage, status, stop, error: chatError, regenerate } =
    useChat({
      transport,
      // The agent saves drafts via a tool — pull the latest into Profile.
      onFinish: () => void refresh(),
    });
  const chatBusy = status === "submitted" || status === "streaming";
  const [scrollToBottomTrigger, setScrollToBottomTrigger] = useState(0);
  const { highlightSegment, isSpeaking, speakAssistantMessageManually, stopSpeech } =
    useChatSpeechSync({
      aiMessages: messages as unknown as AIChatMessage[],
      currentMessages: messages as UIMessage[],
      isLoading: chatBusy,
      speechEnabled: false, // manual speak button only
    });

  const send = (text: string, imageData: string | null = null) => {
    if ((!text.trim() && !imageData) || chatBusy) return false;
    const mediaType = imageData?.match(/^data:([^;]+);/)?.[1];
    void sendMessage({
      text,
      // ponytail: images go inline as data URLs; switch to the Chats upload
      // flow if interview images become common.
      ...(imageData && mediaType
        ? { files: [{ type: "file" as const, mediaType, url: imageData }] }
        : {}),
    });
    setScrollToBottomTrigger((n) => n + 1);
    return true;
  };

  const menuBar = (
    <MatchmakerMenuBar
      onClose={onClose}
      onShowHelp={() => setIsHelpOpen(true)}
      onShowAbout={() => setIsAboutOpen(true)}
      onRefresh={() => void refresh()}
    />
  );

  // ---- Panes -------------------------------------------------------------
  const renderRyo = () =>
    messages.length === 0 ? (
      <div className="flex h-full flex-col items-center justify-center gap-2 p-6 text-center">
        <p>{t("apps.matchmaker.interview.intro")}</p>
        <Button variant="default" onClick={() => send(t("apps.matchmaker.interview.kickoff"))}>
          {t("apps.matchmaker.interview.begin")}
        </Button>
      </div>
    ) : (
      <div className="relative h-full">
        <div className="absolute inset-0 flex flex-col">
          <div className="flex-1 overflow-hidden">
            <ChatMessages
              messages={messages as unknown as ChatMessage[]}
              isLoading={chatBusy}
              error={chatError}
              onRetry={() => void regenerate()}
              isRoomView={false}
              username={username ?? undefined}
              fontSize={fontSize}
              scrollToBottomTrigger={scrollToBottomTrigger}
              highlightSegment={highlightSegment}
              isSpeaking={isSpeaking}
              speakAssistantMessageManually={speakAssistantMessageManually}
              stopSpeech={stopSpeech}
            />
          </div>
        </div>
        <div className="absolute bottom-0 left-0 z-10 w-full p-2">
          <ChatInput
            isLoading={chatBusy}
            isForeground={isForeground}
            onSubmitMessage={(text, imageData) => send(text, imageData)}
            onStop={() => void stop()}
            isSpeechPlaying={isSpeaking}
          />
        </div>
      </div>
    );

  const renderWeek = () => {
    if (drop) {
      const matched = drop.roomId !== null;
      const respond = (action: "accept" | "decline" | "block") =>
        run(async () => {
          setDrop((await respondToMatchDrop(action)).drop);
          if (action === "accept") void refresh();
        });
      return (
        <div className="flex flex-col gap-2 p-3">
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
            <Button variant="default" onClick={() => openChatRoomFromNotification(drop.roomId)}>
              {t("apps.matchmaker.week.openChat")}
            </Button>
          ) : drop.myResponse === "pending" ? (
            <div className="flex gap-1.5">
              <Button variant="default" disabled={busy} onClick={() => respond("accept")}>
                {t("apps.matchmaker.week.accept")}
              </Button>
              <Button variant="secondary" disabled={busy} onClick={() => respond("decline")}>
                {t("apps.matchmaker.week.pass")}
              </Button>
              <Button variant="destructive" disabled={busy} onClick={() => respond("block")}>
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
        <div className="flex flex-col items-center gap-2 p-6 text-center">
          <p>{t("apps.matchmaker.week.intro")}</p>
          <Button variant="default" onClick={() => setPane("ryo")}>
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
    <div className="flex flex-col gap-2 p-3">
      <p className="text-neutral-500">{t("apps.matchmaker.profile.hint")}</p>
      <OsTextarea
        value={draftText}
        onChange={(e) => {
          draftDirtyRef.current = true;
          setDraftText(e.target.value);
        }}
        maxLength={600}
        rows={6}
        placeholder={t("apps.matchmaker.profile.placeholder")}
      />
      {profile && profile.tags.length > 0 && (
        <div className="text-neutral-500">{profile.tags.join(" · ")}</div>
      )}
      <div className="flex flex-wrap gap-1.5">
        <Button
          variant="default"
          disabled={busy || draftText.trim().length < 20}
          onClick={() =>
            run(async () => {
              setProfile((await updateMatchProfile({ action: "approve", text: draftText })).profile);
              draftDirtyRef.current = false;
            })
          }
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
                draftDirtyRef.current = false;
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

  // ---- Sidebar (mirrors Chats' room sidebar) -------------------------------
  const sidebarItem = (id: Pane, label: string) => (
    <div
      key={id}
      className={cn("os-app-sidebar-item py-1 px-5", pane !== id && "hover:bg-black/5")}
      data-selected={pane === id ? "true" : undefined}
      onClick={() => setPane(id)}
    >
      {label}
    </div>
  );

  const sidebar = (
    <div className={osAppSidebarSurfaceClassName({ isMacOSTheme, isWindowsTheme, isAquaGlass }, { layout: "side" })}>
      <div className="pt-3 flex flex-col flex-1 overflow-hidden">
        <div className="os-app-sidebar-header mb-2 px-3">
          <h2 className="text-[14px] pl-1">{getTranslatedAppName("matchmaker")}</h2>
        </div>
        <div className="os-app-sidebar-list space-y-1 w-full flex-1 overflow-y-auto min-h-0">
          {sidebarItem("ryo", t("apps.matchmaker.sidebar.ryo"))}
          {sidebarItem("week", t("apps.matchmaker.tabs.week"))}
          {sidebarItem("profile", t("apps.matchmaker.tabs.profile"))}
          {matchRooms.length > 0 && (
            <div className="os-app-sidebar-section mt-2 px-4 pt-2 pb-1 w-full !text-[11px] uppercase tracking-wide text-black/50">
              {t("apps.matchmaker.sidebar.matches")}
            </div>
          )}
          {matchRooms.map((room) => (
            <div
              key={room.id}
              className="os-app-sidebar-item py-1 px-5 hover:bg-black/5"
              onClick={() => openChatRoomFromNotification(room.id)}
            >
              @{room.members?.find((m) => m !== username?.toLowerCase())}
            </div>
          ))}
        </div>
      </div>
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
      <div
        className={cn(
          "flex size-full text-[12px] font-geneva-12",
          isWindowsTheme && "border-t border-[#919b9c]"
        )}
      >
        {!isAuthenticated ? (
          <EmptyState message={t("apps.matchmaker.signIn")} className="flex-1" />
        ) : (
          <>
            <div className="h-full">{sidebar}</div>
            <div className={cn("relative flex-1 min-w-0 h-full overflow-y-auto", !isAquaGlass && "bg-white/85")}>
              {error && <p className="px-3 pt-2 text-red-600">{error}</p>}
              {pane === "ryo" ? renderRyo() : pane === "week" ? renderWeek() : renderProfile()}
            </div>
          </>
        )}
      </div>
    </AppWindowShell>
  );
}
