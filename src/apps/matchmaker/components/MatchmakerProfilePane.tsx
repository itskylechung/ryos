import { useEffect, useRef, useState, type ReactNode } from "react";
import { useTranslation } from "react-i18next";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { OsTextarea } from "@/components/ui/os-textarea";
import { cn } from "@/lib/utils";
import { updateMatchProfile, type MatchProfile } from "@/api/matchmaker";
import {
  DATE_STYLES,
  DAY_PARTS,
  DAYS,
  GENDERS,
  isAdult,
  MAX_PHOTOS,
  missingBasics,
  TAIPEI_DISTRICTS,
  type AvailabilitySlot,
  type DatingBasics,
} from "@/shared/dating";

const MAX_PHOTO_CHARS = 190_000; // server cap is 200k; leave headroom

/** Resize + JPEG-compress until the data URL fits the server's per-photo cap. */
async function compressPhoto(file: File): Promise<string> {
  const bitmap = await createImageBitmap(file);
  for (const edge of [1024, 800, 640]) {
    const scale = Math.min(1, edge / Math.max(bitmap.width, bitmap.height));
    const canvas = document.createElement("canvas");
    canvas.width = Math.round(bitmap.width * scale);
    canvas.height = Math.round(bitmap.height * scale);
    canvas.getContext("2d")!.drawImage(bitmap, 0, 0, canvas.width, canvas.height);
    for (const quality of [0.82, 0.7, 0.58]) {
      const url = canvas.toDataURL("image/jpeg", quality);
      if (url.length <= MAX_PHOTO_CHARS) {
        bitmap.close();
        return url;
      }
    }
  }
  bitmap.close();
  throw new Error("bad_photo");
}

interface Props {
  profile: MatchProfile | null;
  photos: string[];
  draftText: string;
  onDraftChange: (text: string) => void;
  onSaved: (res: { profile: MatchProfile; photos: string[] }) => void;
  onLeave: () => void;
  run: (fn: () => Promise<void>) => Promise<void>;
  busy: boolean;
}

export function MatchmakerProfilePane({
  profile,
  photos,
  draftText,
  onDraftChange,
  onSaved,
  onLeave,
  run,
  busy,
}: Props) {
  const { t } = useTranslation();
  const k = (key: string) => t(`apps.matchmaker.profile.${key}`);
  const fileRef = useRef<HTMLInputElement>(null);

  // Text fields edit locally and save on blur; toggles save immediately.
  const [basics, setBasics] = useState<DatingBasics>(profile?.basics ?? {});
  useEffect(() => setBasics(profile?.basics ?? {}), [profile?.basics]);

  const save = (patch: DatingBasics) =>
    run(async () => onSaved(await updateMatchProfile({ action: "basics", basics: patch })));
  const setAndSave = (patch: DatingBasics) => {
    setBasics((b) => ({ ...b, ...patch }));
    void save(patch);
  };
  const toggle = <T extends string>(list: T[] | undefined, item: T) =>
    list?.includes(item) ? list.filter((x) => x !== item) : [...(list ?? []), item];

  const addPhoto = (file: File) =>
    run(async () => {
      const url = await compressPhoto(file);
      onSaved(await updateMatchProfile({ action: "photos", photos: [...photos, url] }));
    });
  const removePhoto = (i: number) =>
    run(async () =>
      onSaved(
        await updateMatchProfile({ action: "photos", photos: photos.filter((_, j) => j !== i) })
      )
    );

  // What still blocks Approve, in the order the user should fix it.
  const saved = profile?.basics ?? {};
  const underage = saved.birthdate ? !isAdult(saved.birthdate) : false;
  const needs = [
    photos.length === 0 && k("needPhoto"),
    missingBasics(saved).length > 0 && k("needBasics"),
    draftText.trim().length < 20 && k("needAbout"),
  ].filter(Boolean) as string[];
  const canApprove = needs.length === 0 && !underage;

  const chip = (selected: boolean, label: string, onClick: () => void) => (
    <Button
      key={label}
      size="sm"
      variant={selected ? "default" : "secondary"}
      disabled={busy}
      onClick={onClick}
    >
      {label}
    </Button>
  );
  const row = (label: string, control: ReactNode) => (
    <label className="flex flex-col gap-1">
      <span className="font-bold">{label}</span>
      {control}
    </label>
  );

  return (
    <div className="flex flex-col gap-3 p-3">
      <p className="text-neutral-500">{k("hint")}</p>

      {/* Photos */}
      <div className="flex flex-col gap-1">
        <span className="font-bold">{k("photos")}</span>
        <div className="flex flex-wrap gap-2">
          {photos.map((src, i) => (
            <div key={i} className="relative size-20 overflow-hidden rounded border border-black/20">
              <img src={src} alt="" className="size-full object-cover" />
              <button
                type="button"
                aria-label={k("removePhoto")}
                className="absolute right-0.5 top-0.5 rounded bg-black/60 px-1 text-white"
                disabled={busy}
                onClick={() => void removePhoto(i)}
              >
                ×
              </button>
            </div>
          ))}
          {photos.length < MAX_PHOTOS && (
            <Button variant="secondary" disabled={busy} className="size-20" onClick={() => fileRef.current?.click()}>
              {k("addPhoto")}
            </Button>
          )}
        </div>
        <input
          ref={fileRef}
          type="file"
          accept="image/*"
          hidden
          onChange={(e) => {
            const file = e.target.files?.[0];
            e.target.value = "";
            if (file) void addPhoto(file);
          }}
        />
      </div>

      {/* Basics */}
      <div className="grid grid-cols-2 gap-2">
        {row(
          k("name"),
          <Input
            value={basics.name ?? ""}
            maxLength={40}
            onChange={(e) => setBasics((b) => ({ ...b, name: e.target.value }))}
            onBlur={() => basics.name?.trim() && basics.name !== saved.name && void save({ name: basics.name })}
          />
        )}
        {row(
          k("birthdate"),
          <Input
            type="date"
            value={basics.birthdate ?? ""}
            onChange={(e) => e.target.value && setAndSave({ birthdate: e.target.value })}
          />
        )}
      </div>
      {underage && <p className="text-red-600">{t("apps.matchmaker.errors.under_18")}</p>}

      {row(k("gender"), <div className="flex flex-wrap gap-1">{GENDERS.map((g) => chip(basics.gender === g, t(`apps.matchmaker.genders.${g}`), () => setAndSave({ gender: g })))}</div>)}
      {row(k("interestedIn"), <div className="flex flex-wrap gap-1">{GENDERS.map((g) => chip(!!basics.interestedIn?.includes(g), t(`apps.matchmaker.genders.${g}`), () => setAndSave({ interestedIn: toggle(basics.interestedIn, g) })))}</div>)}

      {row(
        k("ageRange"),
        <div className="flex items-center gap-1">
          {(["ageMin", "ageMax"] as const).map((key, i) => (
            <span key={key} className="flex items-center gap-1">
              {i === 1 && "–"}
              <Input
                type="number"
                min={18}
                max={99}
                className="w-16"
                value={basics[key] ?? ""}
                onChange={(e) => setBasics((b) => ({ ...b, [key]: e.target.value ? Number(e.target.value) : undefined }))}
                onBlur={() => {
                  const v = basics[key];
                  if (v && v >= 18 && v <= 99 && v !== saved[key]) void save({ [key]: v });
                }}
              />
            </span>
          ))}
        </div>
      )}

      {row(k("district"), <div className="flex flex-wrap gap-1">{TAIPEI_DISTRICTS.map((d) => chip(basics.district === d, t(`apps.matchmaker.districts.${d}`), () => setAndSave({ district: d })))}</div>)}

      {row(
        k("availability"),
        <table className="border-separate border-spacing-0.5 text-center">
          <thead>
            <tr>
              <th />
              {DAYS.map((d) => <th key={d} className="font-normal">{t(`apps.matchmaker.days.${d}`)}</th>)}
            </tr>
          </thead>
          <tbody>
            {DAY_PARTS.map((part) => (
              <tr key={part}>
                <td className="pr-1 text-right">{t(`apps.matchmaker.dayParts.${part}`)}</td>
                {DAYS.map((d) => {
                  const slot = `${d}-${part}` as AvailabilitySlot;
                  const on = !!basics.availability?.includes(slot);
                  return (
                    <td key={slot}>
                      <button
                        type="button"
                        aria-pressed={on}
                        aria-label={`${t(`apps.matchmaker.days.${d}`)} ${t(`apps.matchmaker.dayParts.${part}`)}`}
                        disabled={busy}
                        className={cn("size-6 rounded border border-black/20", on ? "bg-green-500" : "bg-white/70")}
                        onClick={() => setAndSave({ availability: toggle(basics.availability, slot) })}
                      />
                    </td>
                  );
                })}
              </tr>
            ))}
          </tbody>
        </table>
      )}

      {row(k("dateStyles"), <div className="flex flex-wrap gap-1">{DATE_STYLES.map((s) => chip(!!basics.dateStyles?.includes(s), t(`apps.matchmaker.dateStyles.${s}`), () => setAndSave({ dateStyles: toggle(basics.dateStyles, s) })))}</div>)}

      {row(
        k("dealbreakers"),
        <Input
          value={basics.dealbreakers ?? ""}
          maxLength={200}
          placeholder={k("dealbreakersPlaceholder")}
          onChange={(e) => setBasics((b) => ({ ...b, dealbreakers: e.target.value }))}
          onBlur={() => basics.dealbreakers !== saved.dealbreakers && void save({ dealbreakers: basics.dealbreakers ?? "" })}
        />
      )}

      {/* About me */}
      {row(
        k("about"),
        <OsTextarea
          value={draftText}
          onChange={(e) => onDraftChange(e.target.value)}
          maxLength={600}
          rows={5}
          placeholder={k("placeholder")}
        />
      )}
      {profile && profile.tags.length > 0 && (
        <div className="text-neutral-500">{profile.tags.join(" · ")}</div>
      )}

      {needs.length > 0 && (
        <p className="text-neutral-500">{t("apps.matchmaker.profile.needs", { items: needs.join(" · ") })}</p>
      )}
      <div className="flex flex-wrap gap-1.5">
        <Button
          variant="default"
          disabled={busy || !canApprove}
          onClick={() =>
            run(async () => onSaved(await updateMatchProfile({ action: "approve", text: draftText })))
          }
        >
          {profile?.approved && profile.approved === draftText.trim() ? k("approved") : k("approve")}
        </Button>
        {profile?.status === "active" && (
          <Button variant="secondary" disabled={busy} onClick={() => run(async () => onSaved(await updateMatchProfile({ action: "pause" })))}>
            {k("pause")}
          </Button>
        )}
        {profile?.status === "paused" && (
          <Button variant="secondary" disabled={busy} onClick={() => run(async () => onSaved(await updateMatchProfile({ action: "resume" })))}>
            {k("resume")}
          </Button>
        )}
        {profile && profile.status !== "none" && (
          <Button variant="destructive" disabled={busy} onClick={onLeave}>
            {k("leave")}
          </Button>
        )}
      </div>
    </div>
  );
}
