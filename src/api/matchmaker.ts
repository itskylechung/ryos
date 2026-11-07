import { apiRequest } from "@/api/core";
import type { DatingBasics } from "@/shared/dating";

export type MatchStatus = "none" | "active" | "paused";
export type MatchResponse = "pending" | "accepted" | "declined";

export interface MatchProfile {
  draft: string | null;
  approved: string | null;
  tags: string[];
  status: MatchStatus;
  basics: DatingBasics;
  updatedAt: number;
}

type ProfileResponse = { profile: MatchProfile; photos: string[] };

export interface MatchDrop {
  partner: string;
  partnerProfile: string;
  score: number;
  why: string;
  opener: string;
  myResponse: MatchResponse;
  partnerResponse: MatchResponse;
  roomId: string | null;
  createdAt: number;
}

export const getMatchProfile = () =>
  apiRequest<ProfileResponse>({ path: "/api/matchmaker/profile" });

export const updateMatchProfile = (
  body:
    | { action: "approve"; text?: string }
    | { action: "pause" | "resume" }
    | { action: "basics"; basics: DatingBasics }
    | { action: "photos"; photos: string[] }
) =>
  apiRequest<ProfileResponse>({
    path: "/api/matchmaker/profile",
    method: "PUT",
    body,
  });

export const leaveMatchmaker = () =>
  apiRequest<{ success: boolean }>({
    path: "/api/matchmaker/profile",
    method: "DELETE",
  });

export const getMatchDrop = () =>
  apiRequest<{ drop: MatchDrop | null; past: string[] }>({
    path: "/api/matchmaker/drop",
  });

export const respondToMatchDrop = (action: "accept" | "decline" | "block") =>
  apiRequest<{ drop: MatchDrop }>({
    path: "/api/matchmaker/drop",
    method: "POST",
    body: { action },
  });
