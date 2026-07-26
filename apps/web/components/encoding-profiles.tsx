"use client";

import React, { useCallback, useEffect, useRef, useState } from "react";

import {
  dvdVideoSettings,
  type EncodingProfileDto,
} from "../lib/encoding-profiles";

export type EncodingProfilesLoadState =
  | { status: "loading" }
  | { status: "error" }
  | { status: "loaded"; profiles: EncodingProfileDto[] };

interface SaveEncodingProfileInput {
  key?: string;
  displayName?: string;
  sourceProfileId?: string;
  settings: { preset: string; container: "mkv" };
}

interface EncodingProfilesViewProps {
  state: EncodingProfilesLoadState;
  versionSourceId: string | null;
  isSaving: boolean;
  onSave(input: SaveEncodingProfileInput): void;
  onCreateVersion(id: string): void;
  onCancelVersion(): void;
  onSetActive(id: string, isActive: boolean): void;
}

function displayMediaDomain(value: string): string {
  return value === "dvd_video" ? "DVD video" : value;
}

export function EncodingProfilesView({
  state,
  versionSourceId,
  isSaving,
  onSave,
  onCreateVersion,
  onCancelVersion,
  onSetActive,
}: EncodingProfilesViewProps) {
  const profiles = state.status === "loaded" ? state.profiles : [];
  const versionSource = profiles.find(
    (profile) => profile.id === versionSourceId,
  );

  function submit(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const form = new FormData(event.currentTarget);
    const preset = String(form.get("preset") ?? "").trim();
    if (versionSource) {
      onSave({
        sourceProfileId: versionSource.id,
        settings: { preset, container: "mkv" },
      });
      return;
    }
    onSave({
      key: String(form.get("key") ?? "").trim(),
      displayName: String(form.get("displayName") ?? "").trim(),
      settings: { preset, container: "mkv" },
    });
  }

  return (
    <section className="encoding-profiles" aria-labelledby="profiles-title">
      <header className="profiles-header">
        <div>
          <p className="section-eyebrow">Reusable settings</p>
          <h2 id="profiles-title">Encoding Profiles</h2>
          <p>
            Manage immutable DVD video settings for future Encode Jobs.
          </p>
        </div>
      </header>

      <form className="profile-form" onSubmit={submit}>
        <div className="profile-form-heading">
          <h3>
            {versionSource
              ? `Create new version of ${versionSource.displayName}`
              : "Create profile"}
          </h3>
          {versionSource ? (
            <button type="button" onClick={onCancelVersion}>
              Cancel
            </button>
          ) : null}
        </div>
        <div className="profile-fields">
          {!versionSource ? (
            <>
              <label>
                Profile key
                <input name="key" required placeholder="dvd-library" />
              </label>
              <label>
                Display name
                <input name="displayName" required placeholder="DVD library" />
              </label>
            </>
          ) : null}
          <label>
            HandBrake preset
            <input
              key={versionSource?.id ?? "new-profile"}
              name="preset"
              required
              defaultValue={
                versionSource
                  ? (dvdVideoSettings(versionSource)?.preset ?? "")
                  : "Fast 480p30"
              }
            />
          </label>
          <label>
            Container
            <input value="MKV" readOnly aria-readonly="true" />
          </label>
        </div>
        <button type="submit" disabled={isSaving}>
          {isSaving
            ? "Saving…"
            : versionSource
              ? "Save new version"
              : "Create profile"}
        </button>
      </form>

      {state.status === "loading" ? (
        <div className="section-message" aria-live="polite">
          Loading Encoding Profiles…
        </div>
      ) : state.status === "error" ? (
        <div className="section-message section-error" role="status">
          Encoding Profiles are unavailable.
        </div>
      ) : profiles.length === 0 ? (
        <div className="section-message">
          No DVD video Encoding Profiles exist yet.
        </div>
      ) : (
        <div className="profile-list">
          {profiles.map((profile) => {
            const settings = dvdVideoSettings(profile);
            return (
              <article className="profile-card" key={profile.id}>
                <div className="item-heading">
                  <div>
                    <h3>{profile.displayName}</h3>
                    <p>
                      {displayMediaDomain(profile.mediaDomain)} · Version{" "}
                      {profile.version}
                    </p>
                  </div>
                  <span
                    className={`status ${profile.isActive ? "status-ready" : "status-disabled"}`}
                  >
                    {profile.isActive ? "Active" : "Inactive"}
                  </span>
                </div>
                <dl className="profile-settings">
                  <div>
                    <dt>HandBrake preset</dt>
                    <dd>{settings?.preset ?? "Unavailable"}</dd>
                  </div>
                  <div>
                    <dt>Container</dt>
                    <dd>{settings?.container.toUpperCase() ?? "Unavailable"}</dd>
                  </div>
                </dl>
                <div className="profile-actions">
                  <button
                    type="button"
                    onClick={() => onCreateVersion(profile.id)}
                    disabled={isSaving}
                  >
                    Create new version
                  </button>
                  <button
                    type="button"
                    onClick={() => onSetActive(profile.id, !profile.isActive)}
                    disabled={isSaving}
                  >
                    {profile.isActive ? "Deactivate" : "Activate"}
                  </button>
                </div>
              </article>
            );
          })}
        </div>
      )}
    </section>
  );
}

export function EncodingProfilesManager() {
  const mounted = useRef(false);
  const [state, setState] = useState<EncodingProfilesLoadState>({
    status: "loading",
  });
  const [versionSourceId, setVersionSourceId] = useState<string | null>(null);
  const [isSaving, setIsSaving] = useState(false);

  const load = useCallback(async () => {
    try {
      const response = await fetch("/api/encoding-profiles", {
        cache: "no-store",
        headers: { Accept: "application/json" },
      });
      if (!response.ok) {
        throw new Error("Encoding Profiles request failed");
      }
      const body = (await response.json()) as {
        profiles: EncodingProfileDto[];
      };
      if (mounted.current) {
        setState({ status: "loaded", profiles: body.profiles });
      }
    } catch {
      if (mounted.current) {
        setState({ status: "error" });
      }
    }
  }, []);

  useEffect(() => {
    mounted.current = true;
    void load();
    return () => {
      mounted.current = false;
    };
  }, [load]);

  async function save(input: SaveEncodingProfileInput) {
    setIsSaving(true);
    try {
      const response = await fetch("/api/encoding-profiles", {
        method: "POST",
        headers: {
          Accept: "application/json",
          "Content-Type": "application/json",
        },
        body: JSON.stringify(input),
      });
      if (!response.ok) {
        throw new Error("Encoding Profile save failed");
      }
      if (mounted.current) {
        setVersionSourceId(null);
      }
      await load();
    } catch {
      if (mounted.current) {
        setState({ status: "error" });
      }
    } finally {
      if (mounted.current) {
        setIsSaving(false);
      }
    }
  }

  async function setActive(id: string, isActive: boolean) {
    setIsSaving(true);
    try {
      const response = await fetch("/api/encoding-profiles", {
        method: "PATCH",
        headers: {
          Accept: "application/json",
          "Content-Type": "application/json",
        },
        body: JSON.stringify({ id, isActive }),
      });
      if (!response.ok) {
        throw new Error("Encoding Profile state update failed");
      }
      await load();
    } catch {
      if (mounted.current) {
        setState({ status: "error" });
      }
    } finally {
      if (mounted.current) {
        setIsSaving(false);
      }
    }
  }

  return (
    <EncodingProfilesView
      state={state}
      versionSourceId={versionSourceId}
      isSaving={isSaving}
      onSave={(input) => void save(input)}
      onCreateVersion={setVersionSourceId}
      onCancelVersion={() => setVersionSourceId(null)}
      onSetActive={(id, isActive) => void setActive(id, isActive)}
    />
  );
}
