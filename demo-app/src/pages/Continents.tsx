import { useEffect, useState } from 'react';
import { api } from '../services/api';
import type { Continent } from '../services/api';
import './Continents.css';

export function Continents() {
  const [continents, setContinents] = useState<Continent[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    const fetchContinents = async () => {
      try {
        setLoading(true);
        const data = await api.getContinents();
        setContinents(data);
        setError(null);
      } catch (err) {
        setError(err instanceof Error ? err.message : 'Failed to load continents');
      } finally {
        setLoading(false);
      }
    };

    fetchContinents();
  }, []);

  const formatNumber = (num: number): string => {
    return new Intl.NumberFormat().format(num);
  };

  if (loading) {
    return <div className="loading">Loading continents...</div>;
  }

  if (error) {
    return <div className="error">Error: {error}</div>;
  }

  return (
    <div className="continents-page">
      <div className="page-container">
        <h1>Continents</h1>
        <div className="continents-grid">
          {continents.map((continent) => (
            <div key={continent.code} className="continent-card">
              <h2>{continent.name}</h2>
              <div className="continent-code">{continent.code}</div>
              <div className="continent-stats">
                <div className="stat">
                  <span className="stat-label">Area</span>
                  <span className="stat-value">
                    {formatNumber(continent.areaSqKm)} km²
                  </span>
                </div>
                <div className="stat">
                  <span className="stat-label">Population</span>
                  <span className="stat-value">
                    {formatNumber(continent.population)}
                  </span>
                </div>
                <div className="stat">
                  <span className="stat-label">Countries</span>
                  <span className="stat-value">{continent.countries}</span>
                </div>
              </div>
              <div className="continent-details">
                <div className="detail-section">
                  <strong>Oceans:</strong>
                  <div className="tags">
                    {continent.oceans.map((ocean, idx) => (
                      <span key={idx} className="tag">
                        {ocean}
                      </span>
                    ))}
                  </div>
                </div>
                <div className="detail-section">
                  <strong>Lines:</strong>
                  <div className="tags">
                    {continent.lines.map((line, idx) => (
                      <span key={idx} className="tag">
                        {line}
                      </span>
                    ))}
                  </div>
                </div>
                {continent.developedCountries.length > 0 && (
                  <div className="detail-section">
                    <strong>Developed Countries:</strong>
                    <div className="tags">
                      {continent.developedCountries.map((country, idx) => (
                        <span key={idx} className="tag tag-highlight">
                          {country}
                        </span>
                      ))}
                    </div>
                  </div>
                )}
              </div>
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}
