import { Component, type ErrorInfo, type ReactNode } from "react";
import { Link } from "react-router-dom";

type State = { failed: boolean };

/** Catches a page that crashes while drawing, so the person sees a message and a way out instead of a white screen. */
export class ErrorBoundary extends Component<{ children: ReactNode }, State> {
  state: State = { failed: false };

  static getDerivedStateFromError(): State {
    return { failed: true };
  }

  componentDidCatch(error: Error, info: ErrorInfo) {
    console.error("A page failed to draw", error, info.componentStack);
  }

  render() {
    if (!this.state.failed) return this.props.children;
    return <div className="content narrow"><section className="panel stack" role="alert">
      <h1>Something went wrong on this page</h1>
      <p className="muted">Nothing you entered was lost on the server. Go back to the overview, or reload the page and try again.</p>
      <div className="button-row">
        <Link className="button primary" to="/" onClick={() => this.setState({ failed: false })}>Go to overview</Link>
        <button className="button secondary" onClick={() => window.location.reload()}>Reload</button>
      </div>
    </section></div>;
  }
}
