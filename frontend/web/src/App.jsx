import { useSession } from './hooks/useSession.js';
import { DashboardScreen } from './screens/DashboardScreen.jsx';
import { FailedScreen } from './screens/FailedScreen.jsx';
import { LoadingScreen } from './screens/LoadingScreen.jsx';
import { NotInvitedScreen } from './screens/NotInvitedScreen.jsx';
import { SignInScreen } from './screens/SignInScreen.jsx';

const SCREENS = {
  loading: LoadingScreen,
  signedOut: SignInScreen,
  notInvited: NotInvitedScreen,
  failed: FailedScreen,
  signedIn: DashboardScreen,
};

export default function App() {
  const { status } = useSession();
  const Screen = SCREENS[status];
  return <Screen />;
}
