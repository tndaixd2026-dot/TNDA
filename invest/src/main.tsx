import { render } from 'preact';
import { Admin } from './pages/Admin.tsx';
import { Screen } from './pages/Screen.tsx';
import { Student } from './pages/Student.tsx';
import './styles.css';

// 三個頁面各有自己的 HTML（index.html、screen/index.html、admin/index.html），
// 這樣放在 GitHub Pages 的任何子路徑下都能直接開。
function App() {
  const page = document.body.dataset.page;
  if (page === 'screen') return <Screen />;
  if (page === 'admin') return <Admin />;
  return <Student />;
}

render(<App />, document.getElementById('app')!);
