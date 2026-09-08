import { useState, type FormEvent } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";
import { commands, type Agent } from "@/lib/bindings";
import { AppFailure, failure, native } from "@/lib/errors";
import { accountOptions } from "@/lib/queries";
import { Button } from "./ui/button";
import { Input } from "./ui/input";
import { ErrorNotice } from "./page";

export function TokenForm({ agent, close }: { agent: Agent; close: () => void }) {
  const client = useQueryClient();
  const [token, setToken] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<Error | null>(null);
  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const credential = token;
    setToken("");
    setBusy(true);
    setError(null);
    try {
      await native(commands.saveToken(agent, credential));
      const status = await native(commands.refreshAccount(agent));
      await client.invalidateQueries(accountOptions);
      if (status.error) throw new AppFailure(status.error);
      close();
      toast.success("Account connected");
    } catch (error) {
      setError(failure(error));
    } finally {
      setBusy(false);
    }
  }
  return (
    <form onSubmit={(event) => void submit(event)} className="space-y-4">
      <p className="text-sm leading-relaxed text-muted-foreground">
        Use a provider access token{agent === "opencode" ? " or OpenCode Go API key" : ""}.
        Overwatch stores it in your OS credential store. Existing provider sign-in files remain read
        only.
      </p>
      {error && <ErrorNotice error={error} />}
      <Input
        type="password"
        autoComplete="off"
        spellCheck={false}
        aria-label="Provider access token"
        placeholder="Access token"
        value={token}
        onChange={(event) => setToken(event.target.value)}
        disabled={busy}
      />
      <Button type="submit" disabled={busy || !token.trim()}>
        {busy ? "Connecting…" : "Save and connect"}
      </Button>
    </form>
  );
}
