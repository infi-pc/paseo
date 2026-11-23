import { Component } from "react";
import { EditableOverlay } from "./EditableOverlay";

export class EditableOverlayBoundary extends Component {
  state = { failed: false };

  static getDerivedStateFromError() {
    return { failed: true };
  }

  render() {
    return this.state.failed ? null : <EditableOverlay />;
  }
}
