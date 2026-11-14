import { Dropdown, type MenuItem } from "./Dropdown.js";

interface HelpMenuProps {
  onAbout: () => void;
  onBuildNotes: () => void;
}

/** The Help item next to the wordmark. */
export function HelpMenu({ onAbout, onBuildNotes }: HelpMenuProps) {
  const { studio } = window.kynimo;
  const items: MenuItem[] = [
    { key: "about", label: "About the beta", onSelect: onAbout },
    { key: "notes", label: "What's in this build", onSelect: onBuildNotes },
    { key: "feedback", label: "Send feedback", onSelect: () => void window.kynimo.openFeedback() },
    {
      key: "stdio",
      label: "Use stdio instead",
      onSelect: () => void window.kynimo.openStdioHelp(),
    },
    {
      key: "folder",
      label: "Open projects folder",
      onSelect: () => void studio.openProjectsFolder(),
    },
    {
      key: "notices",
      label: "Third-party notices",
      onSelect: () => void window.kynimo.openNotices(),
    },
  ];
  return <Dropdown label="Help" trigger="Help" items={items} triggerClassName="help" />;
}
