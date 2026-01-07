import { Link } from 'react-router-dom';
import './Home.css';

export function Home() {
  return (
    <div className="home">
      <div className="home-container">
        <h1>Welcome to Demo App</h1>
        <p className="subtitle">
          Explore dummy JSON data from Beeceptor Mock API
        </p>
        <div className="feature-grid">
          <Link to="/posts" className="feature-card">
            <h2>📝 Posts</h2>
            <p>Browse blog posts and articles</p>
          </Link>
          <Link to="/comments" className="feature-card">
            <h2>💬 Comments</h2>
            <p>View blog comments and discussions</p>
          </Link>
          <Link to="/countries" className="feature-card">
            <h2>🌍 Countries</h2>
            <p>Explore countries around the world</p>
          </Link>
          <Link to="/continents" className="feature-card">
            <h2>🗺️ Continents</h2>
            <p>Learn about continents and their data</p>
          </Link>
        </div>
      </div>
    </div>
  );
}
