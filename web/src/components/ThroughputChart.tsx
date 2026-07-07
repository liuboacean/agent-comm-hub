import React, { useEffect, useState } from 'react';
import { Card, CardContent, Typography, CircularProgress, Box } from '@mui/material';
import { fetchStatus } from '../api';

function ThroughputChart(): React.ReactElement {
  const [throughput, setThroughput] = useState<number>(0);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    const load = async () => {
      try {
        const s = await fetchStatus();
        setThroughput(s.throughput.last_5min);
      } finally {
        setLoading(false);
      }
    };
    load();
    const interval = setInterval(load, 5000);
    return () => clearInterval(interval);
  }, []);

  if (loading) return <Box sx={{ display: 'flex', justifyContent: 'center', py: 8 }}><CircularProgress /></Box>;

  return (
    <Box>
      <Typography variant="h5" sx={{ mb: 3, fontWeight: 600 }}>消息吞吐</Typography>
      <Card>
        <CardContent>
          <Typography variant="body2" color="text.secondary">近 5 分钟消息量</Typography>
          <Typography variant="h3" sx={{ fontWeight: 700, color: 'primary.main' }}>{throughput.toLocaleString()}</Typography>
          <Typography variant="body2" color="text.secondary" sx={{ mt: 2 }}>消息 / 5分钟</Typography>
        </CardContent>
      </Card>
    </Box>
  );
}

export default ThroughputChart;
