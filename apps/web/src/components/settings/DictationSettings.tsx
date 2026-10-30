/**
 * Settings › General › Dictation.
 *
 * Where the speech model is picked and downloaded, where the disk it uses is
 * freed, and the second home of the "Hold to record" switch. The status comes
 * from the primary environment's server, because that is the machine the model
 * files and the transcription live on.
 *
 * @module DictationSettings
 */
import type { DictationModelId, EnvironmentApi } from "@threadlines/contracts";

import {
  DictationProgressBar,
  DictationProgressLabel,
} from "../../dictation/DictationDownloadProgress";
import { DICTATION_MODEL_PRESENTATION } from "../../dictation/dictationModels";
import { useDictationStatus } from "../../dictation/dictationStatusStore";
import { readEnvironmentApi } from "../../environmentApi";
import { usePrimaryEnvironmentId } from "../../environments/primary/context";
import { useSettings, useUpdateSettings } from "../../hooks/useSettings";
import { formatDownloadSize } from "../../lib/formatBytes";
import { Button } from "../ui/button";
import { Radio, RadioGroup } from "../ui/radio-group";
import { Switch } from "../ui/switch";
import { SettingsRow, SettingsSection } from "./settingsLayout";

const MODEL_ORDER: ReadonlyArray<DictationModelId> = ["parakeet", "moonshine"];

/** The primary computer's dictation status, and a way to run a command there. */
function useDictation() {
  const environmentId = usePrimaryEnvironmentId();
  const status = useDictationStatus(environmentId);
  const runDictationCommand = (run: (api: EnvironmentApi) => Promise<void>) => {
    if (!environmentId) {
      return;
    }
    const api = readEnvironmentApi(environmentId);
    if (!api) {
      return;
    }
    void run(api).catch(() => undefined);
  };
  return { status, runDictationCommand };
}

export function DictationSettings() {
  const { status } = useDictation();

  if (status?.runtime.supported === false) {
    return (
      <SettingsSection id="dictation" place="general.dictation">
        <div className="px-4 py-3.5 text-muted-foreground text-xs sm:px-5">
          Dictation isn&apos;t available on this server&apos;s platform.
        </div>
      </SettingsSection>
    );
  }

  return (
    <SettingsSection id="dictation" place="general.dictation">
      <SpeechModelRow />
      <HoldToRecordRow />
      <DownloadedModelsRow />
    </SettingsSection>
  );
}

/** Which speech model turns speech into text, with each model's download. */
export function SpeechModelRow() {
  const { status, runDictationCommand } = useDictation();
  const { updateSettings } = useUpdateSettings();
  const selectedModel = useSettings((settings) => settings.dictationModel);
  const statusUnknown = status === undefined;

  return (
    <SettingsRow
      place="general.speechModel"
      description="Speech is turned into text on this computer. Nothing is sent to the internet. Pick the small model on an older or low-memory machine."
    >
      <RadioGroup
        className="gap-0 pb-1"
        value={selectedModel}
        onValueChange={(value) => {
          if (value === "parakeet" || value === "moonshine") {
            updateSettings({ dictationModel: value });
          }
        }}
      >
        {MODEL_ORDER.map((modelId) => {
          const presentation = DICTATION_MODEL_PRESENTATION[modelId];
          const modelStatus = status?.models.find((entry) => entry.id === modelId);
          return (
            <div
              key={modelId}
              className="flex flex-col gap-2 border-group-divider border-t py-2.5 first:border-t-0 sm:flex-row sm:items-start sm:justify-between sm:gap-4"
            >
              <div className="flex min-w-0 flex-1 items-start gap-2">
                <Radio
                  value={modelId}
                  aria-label={presentation.name}
                  disabled={statusUnknown}
                  className="mt-0.5"
                />
                <div className="min-w-0 space-y-0.5">
                  <div className="flex flex-wrap items-center gap-x-2">
                    <span className="font-medium text-[13px] text-foreground">
                      {presentation.name}
                    </span>
                    <span className="font-mono text-[11px] text-muted-foreground">
                      {presentation.meta}
                    </span>
                  </div>
                  <p className="text-[12.5px] text-muted-foreground">{presentation.description}</p>
                  {modelStatus?.error ? (
                    <p className="text-[12px] text-destructive-foreground">{modelStatus.error}</p>
                  ) : null}
                </div>
              </div>
              <div className="flex shrink-0 items-center gap-2">
                {modelStatus?.state === "downloading" ? (
                  <>
                    <span className="flex w-32 flex-col gap-1">
                      <DictationProgressBar
                        bytesDownloaded={modelStatus.bytesDownloaded}
                        bytesTotal={modelStatus.bytesTotal}
                      />
                      <DictationProgressLabel
                        bytesDownloaded={modelStatus.bytesDownloaded}
                        bytesTotal={modelStatus.bytesTotal}
                      />
                    </span>
                    <Button
                      size="xs"
                      variant="outline"
                      onClick={() =>
                        runDictationCommand((api) =>
                          api.dictation.cancelDownload({ model: modelId }),
                        )
                      }
                    >
                      Cancel
                    </Button>
                  </>
                ) : modelStatus?.state === "ready" ? (
                  <>
                    <span className="rounded-full border border-success/35 px-2 py-0.5 text-[11px] text-success-foreground">
                      Downloaded
                    </span>
                    <Button
                      size="xs"
                      variant="outline"
                      onClick={() =>
                        runDictationCommand((api) => api.dictation.removeModel({ model: modelId }))
                      }
                    >
                      Remove
                    </Button>
                  </>
                ) : (
                  <Button
                    size="xs"
                    variant="outline"
                    disabled={statusUnknown}
                    onClick={() =>
                      runDictationCommand((api) => api.dictation.downloadModel({ model: modelId }))
                    }
                  >
                    Download
                  </Button>
                )}
              </div>
            </div>
          );
        })}
      </RadioGroup>
    </SettingsRow>
  );
}

export function HoldToRecordRow() {
  const { updateSettings } = useUpdateSettings();
  const holdToRecord = useSettings((settings) => settings.dictationHoldToRecord);
  return (
    <SettingsRow
      place="general.holdToRecord"
      control={
        <Switch
          checked={holdToRecord}
          onCheckedChange={(checked) => updateSettings({ dictationHoldToRecord: Boolean(checked) })}
          aria-label="Hold the mic button to record"
        />
      }
    />
  );
}

/** The disk the downloaded models use, and freeing it; only while some are downloaded. */
export function DownloadedModelsRow() {
  const { status, runDictationCommand } = useDictation();
  const readyModels = status?.models.filter((model) => model.state === "ready") ?? [];
  if (readyModels.length === 0 || !status) return null;
  const readyBytes = readyModels.reduce((sum, model) => sum + model.bytesTotal, 0);
  return (
    <SettingsRow
      place="general.downloadedModels"
      description={
        <span className="font-mono text-[11px]">
          {formatDownloadSize(readyBytes)} · {status.modelsDir}
        </span>
      }
      control={
        <Button
          size="xs"
          variant="ghost"
          onClick={() => {
            for (const model of readyModels) {
              runDictationCommand((api) => api.dictation.removeModel({ model: model.id }));
            }
          }}
        >
          Remove all
        </Button>
      }
    />
  );
}
