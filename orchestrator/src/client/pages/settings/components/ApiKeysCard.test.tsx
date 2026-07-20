import * as api from "@client/api";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { ApiKeysCard } from "./ApiKeysCard";

vi.mock("@client/api", () => ({
  getApiKeys: vi.fn(),
  createApiKey: vi.fn(),
  revokeApiKey: vi.fn(),
}));

const renderCard = () => {
  const queryClient = new QueryClient({
    defaultOptions: {
      queries: { retry: false },
      mutations: { retry: false },
    },
  });
  return render(
    <QueryClientProvider client={queryClient}>
      <ApiKeysCard layoutMode="panel" />
    </QueryClientProvider>,
  );
};

describe("ApiKeysCard", () => {
  beforeEach(() => {
    vi.mocked(api.getApiKeys).mockResolvedValue({
      keys: [
        {
          id: "key-1",
          name: "CI deploy",
          createdAt: "2026-06-01T00:00:00.000Z",
          lastUsedAt: "2026-07-01T00:00:00.000Z",
          revokedAt: null,
        },
      ],
    });
  });

  it("renders keys from the API with name and dates", async () => {
    renderCard();

    expect(await screen.findByText("CI deploy")).toBeInTheDocument();
  });

  it("creates a key and shows the plaintext once with a warning", async () => {
    vi.mocked(api.createApiKey).mockResolvedValue({
      id: "key-2",
      name: "New key",
      createdAt: "2026-07-20T00:00:00.000Z",
      key: "jobops_sk_plaintext_value",
    });

    renderCard();
    await screen.findByText("CI deploy");

    fireEvent.change(screen.getByPlaceholderText("Key name"), {
      target: { value: "New key" },
    });
    fireEvent.click(screen.getByRole("button", { name: /create key/i }));

    await waitFor(() => {
      expect(api.createApiKey).toHaveBeenCalledWith("New key");
    });

    expect(
      await screen.findByDisplayValue("jobops_sk_plaintext_value"),
    ).toBeInTheDocument();
    expect(
      screen.getByText(/will not see this key again/i),
    ).toBeInTheDocument();
  });

  it("revokes a key via the confirm dialog", async () => {
    vi.mocked(api.revokeApiKey).mockResolvedValue({ revoked: true });

    renderCard();
    await screen.findByText("CI deploy");

    fireEvent.click(screen.getByRole("button", { name: /revoke/i }));
    fireEvent.click(screen.getByRole("button", { name: /revoke key/i }));

    await waitFor(() => {
      expect(api.revokeApiKey).toHaveBeenCalledWith("key-1");
    });
  });
});
