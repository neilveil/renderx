import { useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { api } from '../services/api';
import type { Post } from '../services/api';
import './Posts.css';

export function Posts() {
  const [posts, setPosts] = useState<Post[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    const fetchPosts = async () => {
      try {
        setLoading(true);
        const data = await api.getPosts();
        setPosts(data);
        setError(null);
      } catch (err) {
        setError(err instanceof Error ? err.message : 'Failed to load posts');
      } finally {
        setLoading(false);
      }
    };

    fetchPosts();
  }, []);

  if (loading) {
    return <div className="loading">Loading posts...</div>;
  }

  if (error) {
    return <div className="error">Error: {error}</div>;
  }

  return (
    <div className="posts-page">
      <div className="page-container">
        <h1>Blog Posts</h1>
        <div className="posts-grid">
          {posts.map((post) => (
            <Link key={post.id} to={`/posts/${post.id}`} className="post-card">
              <h2>{post.title}</h2>
              <p className="post-body">{post.body}</p>
              <div className="post-meta">
                <span>User ID: {post.userId}</span>
                <span>💬 {post.comment_count} comments</span>
              </div>
            </Link>
          ))}
        </div>
      </div>
    </div>
  );
}
