import { Component, type ReactNode } from "react";

interface Props {
  children: ReactNode;
  fallbackTitle?: string;
}

interface State {
  error: Error | null;
}

export default class ErrorBoundary extends Component<Props, State> {
  state: State = { error: null };

  static getDerivedStateFromError(error: Error): State {
    return { error };
  }

  componentDidCatch(error: Error, info: unknown) {
    console.error("ErrorBoundary caught:", error, info);
  }

  reset = () => this.setState({ error: null });

  render() {
    if (this.state.error) {
      return (
        <div className="flex h-full flex-col items-center justify-center gap-3 p-6 text-center">
          <p className="text-[13px] font-semibold text-red-600">
            {this.props.fallbackTitle ?? "Something went wrong"}
          </p>
          <pre className="max-h-64 max-w-full overflow-auto rounded-lg border border-red-500/30 bg-red-500/10 p-3 text-left text-[11px] leading-relaxed text-red-700">
            {this.state.error.message}
            {"\n\n"}
            {this.state.error.stack}
          </pre>
          <button onClick={this.reset} className="btn-bezel px-3 py-1.5 text-[12px]">
            Try again
          </button>
        </div>
      );
    }
    return this.props.children;
  }
}
