/**
 * POST /api/matchmaker/chat
 *
 * Matchmaker intake interview. Runs Ryo's ToolLoopAgent (`matchmakerIntake`
 * preset) with one tool, `saveMatchProfileDraft`. Long-term memory summaries
 * are injected so Ryo can pre-fill a draft — the draft is never shared until
 * the user approves it via /api/matchmaker/profile.
 */

import {
  convertToModelMessages,
  tool,
  validateUIMessages,
  type ModelMessage,
  type UIMessage,
} from "ai";
import { z } from "zod";
import { apiHandler } from "../_utils/api-handler.js";
import * as RateLimit from "../_utils/_rate-limit.js";
import { DEFAULT_MODEL, getModelInstance } from "../_utils/_aiModels.js";
import { MATCHMAKER_INTAKE_INSTRUCTIONS } from "../_utils/_aiPrompts.js";
import { getMemoryIndex } from "../_utils/_memory.js";
import {
  createRyoToolLoopAgent,
  RYO_AGENT_TIMEOUTS,
} from "../_utils/ryo-agent.js";
import { upsertSpeechDraft } from "../_utils/speech-permit-store.js";
import { resolveSpeechOwner } from "../_utils/speech-permit.js";
import { getAssistantVisibleText } from "../../src/apps/chats/utils/aiMessageText.js";
import { getProfile, MAX_PROFILE_CHARS, saveDraft } from "./_lib.js";

const MAX_HISTORY = 30;

export default apiHandler(
  {
    methods: ["POST"],
    auth: "required",
    parseJsonBody: true,
    contentType: null,
  },
  async ({ req, res, redis, user, origin, logger }) => {
    const username = user!.username;

    const rl = await RateLimit.checkBurstAndDailyLimits({
      namespace: "matchmaker-chat",
      identifierParts: ["user", username],
      burst: { windowSeconds: 60, limit: 10 },
      daily: { windowSeconds: 60 * 60 * 24, limit: 60 },
    });
    if (!rl.ok) {
      res.setHeader("Content-Type", "application/json");
      res.status(429).json({ error: "rate_limit_exceeded", scope: rl.scope });
      return;
    }

    const tools = {
      saveMatchProfileDraft: tool({
        description:
          "Save the user's full match profile draft (first person, 2-5 sentences). " +
          "Call with the complete updated text after every meaningful answer.",
        inputSchema: z.object({
          profile: z.string().min(1).max(MAX_PROFILE_CHARS),
        }),
        execute: async ({ profile }) => {
          await saveDraft(redis, username, profile);
          return { saved: true };
        },
      }),
    };

    let uiMessages: UIMessage[];
    try {
      const body = req.body as { messages?: unknown };
      uiMessages = await validateUIMessages({
        messages: Array.isArray(body?.messages)
          ? body.messages.slice(-MAX_HISTORY)
          : [],
        tools,
      });
    } catch {
      res.setHeader("Content-Type", "application/json");
      res.status(400).json({ error: "Invalid messages" });
      return;
    }

    const [memoryIndex, profile] = await Promise.all([
      getMemoryIndex(redis, username),
      getProfile(redis, username),
    ]);
    const remembered =
      memoryIndex?.memories.map((m) => `- ${m.key}: ${m.summary}`).join("\n") ||
      "(nothing yet)";
    const context: ModelMessage = {
      role: "user",
      content:
        `USERNAME: ${username}\n\n` +
        `WHAT RYO REMEMBERS (private, user must approve anything shared):\n${remembered}\n\n` +
        `CURRENT DRAFT:\n${profile.draft ?? "(none)"}\n\n` +
        `APPROVED PROFILE:\n${profile.approved ?? "(none)"}`,
    };

    const modelId = DEFAULT_MODEL;
    const agent = createRyoToolLoopAgent({
      preset: "matchmakerIntake",
      prepared: {
        selectedModel: getModelInstance(modelId),
        modelId,
        tools,
        instructions: { role: "system", content: MATCHMAKER_INTAKE_INSTRUCTIONS },
        dynamicContextMessages: [context],
        toolsContext: {},
        runtimeContext: { username, channel: "matchmaker", modelId },
      },
    });

    try {
      const result = await agent.stream({
        messages: await convertToModelMessages(uiMessages, {
          tools,
          ignoreIncompleteToolCalls: true,
        }),
        // Must pass explicitly — call-time `timeout` overwrites constructor default.
        timeout: RYO_AGENT_TIMEOUTS.matchmakerIntake,
      });
      if (origin) res.setHeader("Access-Control-Allow-Origin", origin);
      result.pipeUIMessageStreamToResponse(res, {
        status: 200,
        originalMessages: uiMessages,
        generateMessageId: () => crypto.randomUUID(),
        // Lets the reused Chats speak button get a speech permit for Ryo's reply.
        onEnd: async ({ responseMessage }) => {
          const text = getAssistantVisibleText(responseMessage);
          if (!text) return;
          await upsertSpeechDraft({
            redis,
            owner: resolveSpeechOwner({ username, ip: "" }),
            messageId: responseMessage.id,
            text,
          }).catch((error) => logger.error("Matchmaker speech draft failed", error));
        },
      });
    } catch (error) {
      logger.error("Matchmaker chat failed", error);
      res.setHeader("Content-Type", "application/json");
      res.status(500).json({ error: "Internal Server Error" });
    }
  }
);
