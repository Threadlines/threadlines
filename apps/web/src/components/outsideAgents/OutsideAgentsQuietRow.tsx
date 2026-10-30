/**
 * After Deny all, how long new sign-ins stay turned away (local agents' and
 * assistants' alike), with the way back. Settings' Agents and Assistants
 * groups each show it at their top while it lasts.
 */
import { useState } from "react";

import {
  describeOutsideAgentFailure,
  resumeOutsideAgentRequests,
} from "../../environments/outsideAgents/outsideAgents";
import { outsideAgentQuietMinutesLeft } from "../../environments/outsideAgents/outsideAgents.logic";
import { useRelativeTimeTick } from "../../hooks/useRelativeTimeTick";
import { SettingsRow } from "../settings/settingsLayout";
import { Button } from "../ui/button";
import { failureNotice, toastManager } from "../ui/toast";

const WORDS = {
  agent: {
    title: "Not taking new agent sign-ins",
    description: "You denied them all. Agents already connected keep working.",
  },
  assistant: {
    title: "Not taking new assistant sign-ins",
    description: "You denied them all. Assistants already connected keep working.",
  },
} as const;

/** Nothing unless Deny all's quiet period is on. */
export function OutsideAgentsQuietRow({
  quietUntil,
  who,
  testId,
}: {
  readonly quietUntil: string | null;
  readonly who: keyof typeof WORDS;
  readonly testId: string;
}) {
  const nowMs = useRelativeTimeTick(30_000);
  const [resuming, setResuming] = useState(false);
  const minutes = outsideAgentQuietMinutesLeft(quietUntil, nowMs);
  if (minutes === null) return null;

  const resume = async () => {
    setResuming(true);
    try {
      await resumeOutsideAgentRequests();
    } catch (error) {
      toastManager.add(
        failureNotice({
          title: "Couldn't take sign-ins again",
          reason: describeOutsideAgentFailure(error, "Try again."),
        }),
      );
    } finally {
      setResuming(false);
    }
  };

  return (
    <SettingsRow
      data-testid={testId}
      title={`${WORDS[who].title} (${minutes} min left)`}
      description={WORDS[who].description}
      control={
        <Button size="xs" variant="outline" disabled={resuming} onClick={() => void resume()}>
          {resuming ? "Taking requests…" : "Take requests again"}
        </Button>
      }
    />
  );
}
