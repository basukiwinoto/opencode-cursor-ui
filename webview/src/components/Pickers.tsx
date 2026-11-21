/**
 * Compact model / agent selects shared by the header and composer footer.
 */
import { useMemo, type ChangeEvent } from "react";
import type { ModelOption } from "../../../shared/protocol";
import { postToHost } from "../vscodeApi";
import { useAppStore } from "../store";

interface ModelGroup {
  id: string;
  label: string;
  models: ModelOption[];
}

function groupModels(models: ModelOption[], providers: { id: string; name: string }[]): ModelGroup[] {
  const byProvider = new Map<string, ModelOption[]>();
  for (const m of models) {
    const list = byProvider.get(m.providerID) ?? [];
    list.push(m);
    byProvider.set(m.providerID, list);
  }
  const groups: ModelGroup[] = providers
    .map((p) => ({
      id: p.id,
      label: p.name || p.id,
      models: byProvider.get(p.id) ?? [],
    }))
    .filter((g) => g.models.length > 0);
  const known = new Set(groups.map((g) => g.id));
  for (const [providerID, list] of byProvider) {
    if (!known.has(providerID) && list.length > 0) {
      groups.push({ id: providerID, label: providerID, models: list });
    }
  }
  return groups;
}

export function ModelPicker({ className }: { className?: string }) {
  const models = useAppStore((s) => s.models);
  const providers = useAppStore((s) => s.providers);
  const selectedModel = useAppStore((s) => s.selectedModel);
  const groups = useMemo(() => groupModels(models, providers), [models, providers]);
  const selected = selectedModel ? `${selectedModel.providerID}:${selectedModel.modelID}` : "";

  const onChange = (event: ChangeEvent<HTMLSelectElement>) => {
    const value = event.target.value;
    const sep = value.indexOf(":");
    if (sep <= 0) return;
    postToHost({
      type: "selectModel",
      providerID: value.slice(0, sep),
      modelID: value.slice(sep + 1),
    });
  };

  return (
    <select
      className={className ? `picker ${className}` : "picker"}
      value={selected}
      onChange={onChange}
      aria-label="Model"
      title={selectedModel ? `${selectedModel.providerID} / ${selectedModel.modelID}` : "Select model"}
    >
      <option value="">Model…</option>
      {groups.map((g) => (
        <optgroup key={g.id} label={g.label}>
          {g.models.map((m) => (
            <option key={`${m.providerID}:${m.modelID}`} value={`${m.providerID}:${m.modelID}`}>
              {m.label || m.modelID}
            </option>
          ))}
        </optgroup>
      ))}
    </select>
  );
}

export function AgentPicker({ className }: { className?: string }) {
  const agents = useAppStore((s) => s.agents);
  const selectedAgent = useAppStore((s) => s.selectedAgent);

  return (
    <select
      className={className ? `picker ${className}` : "picker"}
      value={selectedAgent ?? ""}
      onChange={(event) => {
        const value = event.target.value;
        if (value) postToHost({ type: "selectAgent", agentID: value });
      }}
      aria-label="Agent"
      title="Agent"
    >
      <option value="">Agent…</option>
      {agents.map((a) => (
        <option key={a.id} value={a.id}>
          {a.name}
        </option>
      ))}
    </select>
  );
}
