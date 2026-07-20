import type { ApiKeySummary } from "@client/api";
import * as api from "@client/api";
import { EmptyState, ListPanel } from "@client/components/layout";
import { SettingsSectionFrame } from "@client/pages/settings/components/SettingsSectionFrame";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { KeyRound } from "lucide-react";
import type React from "react";
import { useState } from "react";
import { toast } from "sonner";
import { showErrorToast } from "@/client/lib/error-toast";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
  AlertDialogTrigger,
} from "@/components/ui/alert-dialog";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { formatDateTime } from "@/lib/utils";

type ApiKeysCardProps = {
  layoutMode?: "accordion" | "panel";
};

const apiKeysQueryKey = ["auth", "api-keys"] as const;

export const ApiKeysCard: React.FC<ApiKeysCardProps> = ({ layoutMode }) => {
  const queryClient = useQueryClient();
  const [name, setName] = useState("");
  // Plaintext key lives only here, in component state, never in the query
  // cache or localStorage. It's shown once and dropped on "Done" or unmount.
  const [createdKey, setCreatedKey] = useState<api.CreatedApiKey | null>(null);
  const [copied, setCopied] = useState(false);

  const keysQuery = useQuery({
    queryKey: apiKeysQueryKey,
    queryFn: api.getApiKeys,
  });

  const createMutation = useMutation({
    mutationFn: (input: { name: string }) => api.createApiKey(input.name),
    onSuccess: async (created) => {
      setCreatedKey(created);
      setCopied(false);
      setName("");
      await queryClient.invalidateQueries({ queryKey: apiKeysQueryKey });
    },
    onError: (error) => {
      showErrorToast(error, "Failed to create API key");
    },
  });

  const revokeMutation = useMutation({
    mutationFn: (id: string) => api.revokeApiKey(id),
    onSuccess: async () => {
      toast.success("API key revoked");
      await queryClient.invalidateQueries({ queryKey: apiKeysQueryKey });
    },
    onError: (error) => {
      showErrorToast(error, "Failed to revoke API key");
    },
  });

  const keys: ApiKeySummary[] = keysQuery.data?.keys ?? [];

  const handleCopy = async () => {
    if (!createdKey) return;
    await navigator.clipboard.writeText(createdKey.key);
    setCopied(true);
  };

  return (
    <SettingsSectionFrame mode={layoutMode} title="API Keys" value="api-keys">
      <div className="space-y-5">
        <div className="space-y-1">
          <div className="text-sm font-semibold">API Keys</div>
          <p className="text-sm text-muted-foreground">
            Create keys for programmatic access to the JobOps API and MCP
            server.
          </p>
        </div>

        {createdKey ? (
          <div className="space-y-2 rounded-md border border-amber-500/40 bg-amber-500/[0.06] p-3">
            <div className="text-sm font-medium">
              &ldquo;{createdKey.name}&rdquo; created
            </div>
            <div className="flex gap-2">
              <Input
                readOnly
                value={createdKey.key}
                className="font-mono text-xs"
                onFocus={(event) => event.currentTarget.select()}
              />
              <Button
                type="button"
                variant="outline"
                size="sm"
                onClick={handleCopy}
              >
                {copied ? "Copied" : "Copy"}
              </Button>
            </div>
            <p className="text-xs text-amber-700 dark:text-amber-400">
              Copy this key now — you will not see this key again.
            </p>
            <Button
              type="button"
              variant="ghost"
              size="sm"
              onClick={() => setCreatedKey(null)}
            >
              Done
            </Button>
          </div>
        ) : null}

        <div className="flex gap-2">
          <Input
            value={name}
            onChange={(event) => setName(event.currentTarget.value)}
            placeholder="Key name"
          />
          <Button
            type="button"
            onClick={() => createMutation.mutate({ name })}
            disabled={createMutation.isPending || name.trim().length === 0}
          >
            {createMutation.isPending ? "Creating..." : "Create key"}
          </Button>
        </div>

        <ListPanel>
          {keysQuery.isLoading ? (
            <div className="p-3 text-sm text-muted-foreground">Loading...</div>
          ) : keys.length === 0 ? (
            <EmptyState
              icon={KeyRound}
              title="No API keys yet"
              description="Create a key to access JobOps programmatically."
            />
          ) : (
            keys.map((key) => (
              <div
                key={key.id}
                className="flex items-center justify-between gap-3 p-3"
              >
                <div className="min-w-0">
                  <div className="flex flex-wrap items-center gap-2">
                    <span className="truncate text-sm font-medium">
                      {key.name}
                    </span>
                    {key.revokedAt ? (
                      <Badge variant="destructive">Revoked</Badge>
                    ) : null}
                  </div>
                  <div className="text-xs text-muted-foreground">
                    Created {formatDateTime(key.createdAt)} · Last used{" "}
                    {key.lastUsedAt ? formatDateTime(key.lastUsedAt) : "Never"}
                  </div>
                </div>
                {!key.revokedAt ? (
                  <AlertDialog>
                    <AlertDialogTrigger asChild>
                      <Button
                        type="button"
                        variant="outline"
                        size="sm"
                        disabled={revokeMutation.isPending}
                      >
                        Revoke
                      </Button>
                    </AlertDialogTrigger>
                    <AlertDialogContent>
                      <AlertDialogHeader>
                        <AlertDialogTitle>
                          Revoke &ldquo;{key.name}&rdquo;?
                        </AlertDialogTitle>
                        <AlertDialogDescription>
                          Any application using this key will immediately lose
                          access. This action cannot be undone.
                        </AlertDialogDescription>
                      </AlertDialogHeader>
                      <AlertDialogFooter>
                        <AlertDialogCancel>Cancel</AlertDialogCancel>
                        <AlertDialogAction
                          onClick={() => revokeMutation.mutate(key.id)}
                          className="bg-destructive text-destructive-foreground hover:bg-destructive/90"
                        >
                          Revoke key
                        </AlertDialogAction>
                      </AlertDialogFooter>
                    </AlertDialogContent>
                  </AlertDialog>
                ) : null}
              </div>
            ))
          )}
        </ListPanel>
      </div>
    </SettingsSectionFrame>
  );
};
