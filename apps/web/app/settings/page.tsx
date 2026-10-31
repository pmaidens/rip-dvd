import { EncodingProfilesManager } from "../../components/encoding-profiles";
import { NotificationSettings } from "../../components/notification-settings";

export default function SettingsPage() {
  return <main className="settings-page">
    <h1>Settings</h1>
    <nav className="settings-section-navigation" aria-label="Settings sections">
      <a href="#notifications">Notifications</a>
      <a href="#encoding-profiles">Encoding Profiles</a>
    </nav>
    <NotificationSettings />
    <EncodingProfilesManager />
  </main>;
}
