import { Component, type ReactNode } from "react";
import { failure } from "@/lib/errors";
import { ErrorNotice } from "./page";

export class ErrorBoundary extends Component<{ children: ReactNode }, { error: Error | null }> {
  state = { error: null as Error | null };

  static getDerivedStateFromError(error: unknown) {
    return { error: failure(error) };
  }

  render() {
    return this.state.error ? (
      <ErrorNotice error={this.state.error} retry={() => this.setState({ error: null })} />
    ) : (
      this.props.children
    );
  }
}
