import { BrowserRouter as Router, Routes, Route } from 'react-router-dom';
import { Navigation } from './components/Navigation';
import { Home } from './pages/Home';
import { Posts } from './pages/Posts';
import { PostDetail } from './pages/PostDetail';
import { Comments } from './pages/Comments';
import { Countries } from './pages/Countries';
import { Continents } from './pages/Continents';
import './App.css';

function App() {
  return (
    <Router>
      <div className="app">
        <Navigation />
        <main className="main-content">
          <Routes>
            <Route path="/" element={<Home />} />
            <Route path="/posts" element={<Posts />} />
            <Route path="/posts/:id" element={<PostDetail />} />
            <Route path="/comments" element={<Comments />} />
            <Route path="/countries" element={<Countries />} />
            <Route path="/continents" element={<Continents />} />
          </Routes>
        </main>
      </div>
    </Router>
  );
}

export default App;
