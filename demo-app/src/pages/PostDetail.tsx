import { useEffect, useState } from 'react';
import { useParams, Link } from 'react-router-dom';
import { api } from '../services/api';
import type { Post } from '../services/api';
import './PostDetail.css';

export function PostDetail() {
  const { id } = useParams<{ id: string }>();
  const [post, setPost] = useState<Post | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    const fetchPost = async () => {
      if (!id) return;
      try {
        setLoading(true);
        const data = await api.getPost(parseInt(id));
        setPost(data);
        setError(null);
      } catch (err) {
        setError(err instanceof Error ? err.message : 'Failed to load post');
      } finally {
        setLoading(false);
      }
    };

    fetchPost();
  }, [id]);

  if (loading) {
    return <div className="loading">Loading post...</div>;
  }

  if (error) {
    return <div className="error">Error: {error}</div>;
  }

  if (!post) {
    return <div className="error">Post not found</div>;
  }

  return (
    <div className="post-detail-page">
      <div className="page-container">
        <Link to="/posts" className="back-link">← Back to Posts</Link>
        <article className="post-detail">
          <h1>{post.title}</h1>
          <div className="post-info">
            <span>User ID: {post.userId}</span>
            <span>Post ID: {post.id}</span>
            <span>💬 {post.comment_count} comments</span>
          </div>
          <p className="post-content">{post.body}</p>
          {post.link && (
            <a
              href={post.link}
              target="_blank"
              rel="noopener noreferrer"
              className="post-link"
            >
              Read more →
            </a>
          )}
        </article>
      </div>
    </div>
  );
}
