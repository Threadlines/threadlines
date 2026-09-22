import type { McpElicitation } from "@threadlines/contracts";
import {
  mcpElicitationUrl,
  validateMcpElicitationContent,
} from "@threadlines/shared/mcpElicitation";
import { useId, useState } from "react";
import { Button } from "../ui/button";
import { Input } from "../ui/input";
import { ensureLocalApi } from "../../localApi";

/** Tool forms use the normal pending-input lifecycle, including reconnect and cancellation. */
export function ComposerMcpElicitation({
  prompt,
  disabled,
  onRespond,
}: {
  prompt: McpElicitation;
  disabled: boolean;
  onRespond: (answers: Record<string, unknown>) => void;
}) {
  const id = useId();
  const [content, setContent] = useState<Record<string, unknown>>(() =>
    Object.fromEntries(
      prompt.mode === "form"
        ? prompt.fields.flatMap((field) =>
            field.defaultValue === undefined ? [] : [[field.name, field.defaultValue]],
          )
        : [],
    ),
  );
  const [error, setError] = useState<string>();
  const update = (name: string, value: unknown) =>
    setContent((previous) => {
      const next = { ...previous, [name]: value };
      if (value === undefined) delete next[name];
      return next;
    });
  const accept = () => {
    const error = validateMcpElicitationContent(prompt, content);
    setError(error);
    if (!error) onRespond({ action: "accept", content: prompt.mode === "form" ? content : null });
  };
  const url = prompt.mode === "url" ? mcpElicitationUrl(prompt.url) : null;
  return (
    <div className="max-h-[50dvh] overflow-y-auto px-4 py-3 text-sm sm:px-5">
      <p className="text-xs font-medium text-muted-foreground">{prompt.serverName}</p>
      <p className="mt-1 whitespace-pre-wrap">{prompt.message}</p>
      {prompt.mode === "url" ? (
        <div className="mt-2 flex items-center gap-2">
          <Button
            type="button"
            size="sm"
            variant="outline"
            disabled={disabled || !url}
            onClick={() => {
              if (url)
                void ensureLocalApi()
                  .shell.openExternal(url)
                  .catch(() => setError("Could not open the link. Try again."));
            }}
          >
            Open link
          </Button>
          <span className="min-w-0 truncate text-xs text-muted-foreground" title={prompt.url}>
            {url ? new URL(url).host : "Unsupported link"}
          </span>
        </div>
      ) : (
        <div className="mt-3 divide-y divide-border">
          {prompt.fields.map((field, index) => {
            const value = content[field.name];
            const fieldId = `${id}-${index}`;
            const options =
              field.type === "boolean"
                ? [
                    { value: "true", label: "Yes" },
                    { value: "false", label: "No" },
                  ]
                : field.options;
            return (
              <div key={field.name} className="space-y-1.5 py-2 first:pt-0">
                <label
                  id={`${fieldId}-label`}
                  htmlFor={options ? undefined : fieldId}
                  className="text-xs font-medium"
                >
                  {field.title}
                  {field.required ? " *" : " (optional)"}
                </label>
                {field.description ? (
                  <p className="text-xs text-muted-foreground">{field.description}</p>
                ) : null}
                {options ? (
                  <div
                    role="group"
                    aria-labelledby={`${fieldId}-label`}
                    className="flex flex-wrap gap-1"
                  >
                    {options.map((option) => {
                      const selected =
                        field.type === "array"
                          ? Array.isArray(value) && value.includes(option.value)
                          : String(value) === option.value;
                      return (
                        <Button
                          key={option.value}
                          type="button"
                          size="sm"
                          variant={selected ? "secondary" : "ghost"}
                          aria-pressed={selected}
                          disabled={disabled}
                          onClick={() => {
                            if (field.type === "array") {
                              const values = Array.isArray(value) ? value : [];
                              update(
                                field.name,
                                selected
                                  ? values.filter((entry) => entry !== option.value)
                                  : [...values, option.value],
                              );
                            } else
                              update(
                                field.name,
                                selected
                                  ? undefined
                                  : field.type === "boolean"
                                    ? option.value === "true"
                                    : option.value,
                              );
                          }}
                        >
                          {option.label}
                        </Button>
                      );
                    })}
                  </div>
                ) : (
                  <Input
                    id={fieldId}
                    nativeInput
                    size="sm"
                    disabled={disabled}
                    type={
                      field.type === "number" || field.type === "integer"
                        ? "number"
                        : field.format === "email"
                          ? "email"
                          : field.format === "date"
                            ? "date"
                            : "text"
                    }
                    value={typeof value === "string" || typeof value === "number" ? value : ""}
                    min={field.minimum}
                    max={field.maximum}
                    step={field.type === "integer" ? 1 : "any"}
                    required={field.required}
                    minLength={field.minLength}
                    maxLength={field.maxLength}
                    onChange={(event) =>
                      update(
                        field.name,
                        event.target.value === ""
                          ? undefined
                          : field.type === "number" || field.type === "integer"
                            ? event.target.valueAsNumber
                            : event.target.value,
                      )
                    }
                  />
                )}
              </div>
            );
          })}
        </div>
      )}
      {error ? (
        <p role="alert" className="mt-2 text-xs text-destructive">
          {error}
        </p>
      ) : null}
      <div className="mt-3 flex justify-end gap-1">
        <Button
          type="button"
          size="sm"
          variant="ghost"
          disabled={disabled}
          onClick={() => onRespond({ action: "cancel" })}
        >
          Cancel
        </Button>
        <Button
          type="button"
          size="sm"
          variant="ghost"
          disabled={disabled}
          onClick={() => onRespond({ action: "decline" })}
        >
          Decline
        </Button>
        <Button
          type="button"
          size="sm"
          disabled={disabled || (prompt.mode === "url" && !url)}
          onClick={accept}
        >
          {prompt.mode === "url" ? "Done" : "Submit"}
        </Button>
      </div>
    </div>
  );
}
