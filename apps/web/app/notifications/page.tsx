import { permanentRedirect } from "next/navigation";

export default function NotificationsPage() {
  permanentRedirect("/settings#notifications");
}
