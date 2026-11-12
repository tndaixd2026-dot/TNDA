import { render } from 'preact';
import { Admin } from './pages/Admin.tsx';
import { Screen } from './pages/Screen.tsx';
import { Student } from './pages/Student.tsx';
import './styles.css';

function App() {
  const path = location.pathname.replace(/\/+$/, '');
  if (path === '/screen') return <Screen />;
  if (path === '/admin') return <Admin />;
  return <Student />;
}

render(<App />, document.getElementById('app')!);
