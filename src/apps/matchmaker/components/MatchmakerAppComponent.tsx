import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { useChat, type UIMessage } from "@ai-sdk/react";
import { DefaultChatTransport } from "ai";
import { AppProps } from "@/apps/base/types";
import { AppWindowShell } from "@/components/shared/AppWindowShell";
import { AppHelpAboutDialogs } from "@/components/shared/AppHelpAboutDialogs";
import { osAppSidebarSurfaceClassName } from "@/components/shared/osThemePrimitives";
import { Button } from "@/components/ui/button";
import { EmptyState } from "@/components/ui/empty-state";
// Reuse Chats' message list + input so the interview looks and behaves like
// talking to Ryo in Chats (bubbles, tool status rows, speech, theming).
import { ChatMessages } from "@/apps/chats/components/ChatMessages";
import { ChatInput } from "@/apps/chats/components/ChatInput";
import type { ChatMessage } from "@/apps/chats/components/chat-messages/types";
import { useChatSpeechSync } from "@/apps/chats/hooks/useChatSpeechSync";
import { useAudioTranscription } from "@/hooks/useAudioTranscription";
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
  type MatchDrop,
  type MatchProfile,
} from "@/api/matchmaker";
import { appMetadata, helpItems } from "..";
import { MatchmakerMenuBar } from "./MatchmakerMenuBar";
import { MatchmakerProfilePane } from "./MatchmakerProfilePane";

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
  const [photos, setPhotos] = useState<string[]>([]);
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
      setPhotos(p.photos);
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

  // While you've said yes and they haven't answered, re-check so the card
  // flips to Open Chat on its own. ponytail: 10s polling; switch to a
  // realtime push when date plans land.
  const waitingOnThem = drop?.myResponse === "accepted" && !drop.roomId;
  useEffect(() => {
    if (!isWindowOpen || !waitingOnThem) return;
    const timer = setInterval(() => void refresh(), 10_000);
    return () => clearInterval(timer);
  }, [isWindowOpen, waitingOnThem, refresh]);

  const run = async (fn: () => Promise<void>) => {
    setBusy(true);
    setError(null);
    try {
      await fn();
    } catch (e) {
      // Server error codes (need_photo, under_18, …) have friendly text.
      const message = e instanceof Error ? e.message : String(e);
      setError(t(`apps.matchmaker.errors.${message}`, { defaultValue: message }));
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
  // Voice call: Ryo speaks every reply, and the mic reopens whenever Ryo is
  // done talking, so onboarding feels like a phone call with a friend.
  const [onCall, setOnCall] = useState(false);
  const onCallRef = useRef(false);
  onCallRef.current = onCall;
  const speakFinalRef = useRef<(m: UIMessage) => void>(() => {});
  const { messages, sendMessage, status, stop, error: chatError, regenerate } =
    useChat({
      transport,
      onFinish: ({ message }) => {
        if (onCallRef.current) speakFinalRef.current(message);
        // The agent saves drafts via a tool — pull the latest into Profile.
        void refresh();
      },
    });
  const chatBusy = status === "submitted" || status === "streaming";
  // The speech hook treats `aiMessages` as already-heard history, so hold it
  // at the pre-send snapshot while Ryo's reply is still streaming.
  const settledMessagesRef = useRef(messages);
  if (!chatBusy) settledMessagesRef.current = messages;
  const [scrollToBottomTrigger, setScrollToBottomTrigger] = useState(0);
  const {
    highlightSegment,
    isSpeaking,
    speakAssistantMessageManually,
    speakFinalAssistantMessage,
    stopSpeech,
  } = useChatSpeechSync({
    aiMessages: settledMessagesRef.current as unknown as AIChatMessage[],
    currentMessages: messages as UIMessage[],
    isLoading: chatBusy,
    speechEnabled: onCall, // off the call: manual speak button only
  });
  speakFinalRef.current = speakFinalAssistantMessage;

  // "listening" → mic open; "transcribing" → turning speech into text.
  const [micPhase, setMicPhase] = useState<"idle" | "listening" | "transcribing">("idle");
  const mic = useAudioTranscription({
    onTranscriptionComplete: (text) => {
      if (onCallRef.current) send(text);
    },
    onTranscriptionEnd: () => setMicPhase("idle"),
    onRecordingStateChange: (recording) => {
      if (!recording) setMicPhase("transcribing");
    },
    onError: (e) => {
      setOnCall(false);
      setMicPhase("idle");
      setError(e.message);
    },
    silenceThreshold: 1200,
    minRecordingDuration: 500,
  });
  // startRecording's identity changes every render; keep it out of effect deps.
  const startRecordingRef = useRef(mic.startRecording);
  startRecordingRef.current = mic.startRecording;
  const hangUp = () => {
    setOnCall(false);
    setMicPhase("idle");
    mic.stopRecording();
    stopSpeech();
  };
  const hangUpRef = useRef(hangUp);
  hangUpRef.current = hangUp;
  // Closing the window ends the call and releases the mic.
  useEffect(() => {
    if (!isWindowOpen) hangUpRef.current();
    return () => hangUpRef.current();
  }, [isWindowOpen]);
  // Ryo's speech arrives clip by clip, so `isSpeaking` blinks off between
  // clips; the highlight queue stays set until the last clip finishes.
  const ryoTalking = chatBusy || isSpeaking || highlightSegment !== null;
  useEffect(() => {
    if (!onCall || micPhase !== "idle" || ryoTalking) return;
    // ponytail: fixed 700ms settle before reopening the mic; true barge-in
    // (talking over Ryo) needs a realtime speech-to-speech session.
    const timer = setTimeout(() => {
      setMicPhase("listening");
      void startRecordingRef.current();
    }, 700);
    return () => clearTimeout(timer);
  }, [onCall, micPhase, ryoTalking]);
  const startCall = () => {
    setPane("ryo");
    setOnCall(true);
    // Fresh interview: Ryo opens the call (drafting from memories if it can).
    if (messages.length === 0) send(t("apps.matchmaker.interview.kickoff"));
  };

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
        <div className="flex gap-1.5">
          <Button variant="default" onClick={startCall}>
            {t("apps.matchmaker.interview.call")}
          </Button>
          <Button variant="secondary" onClick={() => send(t("apps.matchmaker.interview.kickoff"))}>
            {t("apps.matchmaker.interview.begin")}
          </Button>
        </div>
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
          {onCall ? (
            <div className="flex items-center gap-2 rounded-md bg-white/90 px-3 py-2 shadow">
              <span
                className={cn(
                  "size-2 shrink-0 rounded-full",
                  micPhase === "listening" ? "animate-pulse bg-red-500" : "bg-neutral-400"
                )}
              />
              <button
                type="button"
                className="flex-1 text-left"
                // Tapping while Ryo talks cuts it off so you can answer.
                onClick={() => {
                  if (!chatBusy && ryoTalking) stopSpeech();
                }}
              >
                {micPhase === "listening"
                  ? t("apps.matchmaker.call.listening")
                  : micPhase === "transcribing" || chatBusy
                    ? t("apps.matchmaker.call.thinking")
                    : ryoTalking
                      ? t("apps.matchmaker.call.talking")
                      : t("apps.matchmaker.call.connecting")}
              </button>
              <Button variant="destructive" onClick={hangUp}>
                {t("apps.matchmaker.call.hangUp")}
              </Button>
            </div>
          ) : (
            <div className="flex items-end gap-1.5">
              <div className="min-w-0 flex-1">
                <ChatInput
                  isLoading={chatBusy}
                  isForeground={isForeground}
                  onSubmitMessage={(text, imageData) => send(text, imageData)}
                  onStop={() => void stop()}
                  isSpeechPlaying={isSpeaking}
                />
              </div>
              <Button variant="secondary" onClick={startCall}>
                {t("apps.matchmaker.interview.call")}
              </Button>
            </div>
          )}
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
    <MatchmakerProfilePane
      profile={profile}
      photos={photos}
      draftText={draftText}
      onDraftChange={(text) => {
        draftDirtyRef.current = true;
        setDraftText(text);
      }}
      onSaved={(res) => {
        setProfile(res.profile);
        setPhotos(res.photos);
        // After approve, the server's approved text is the source of truth.
        if (res.profile.approved === draftText.trim()) draftDirtyRef.current = false;
      }}
      onLeave={() =>
        run(async () => {
          await leaveMatchmaker();
          draftDirtyRef.current = false;
          await refresh();
        })
      }
      run={run}
      busy={busy}
    />
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
