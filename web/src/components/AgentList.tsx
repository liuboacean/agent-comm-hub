import React, { useEffect, useState } from 'react';
import {
  Table, TableBody, TableCell, TableContainer, TableHead, TableRow, Paper, Chip, Typography, CircularProgress, Box,
} from '@mui/material';
import { fetchStatus } from '../api';

function AgentList(): React.ReactElement {
  const [agents, setAgents] = useState<Array<{ id: string; state: string }>>([]);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    const load = async () => {
      try {
        const s = await fetchStatus();
        const data = Object.entries(s.agents.by_state).map(([state, count]) => ({ id: `${state} (${count})`, state }));
        // Also show agent total
        setAgents(data);
      } finally {
        setLoading(false);
      }
    };
    load();
  }, []);

  if (loading) return <Box sx={{ display: 'flex', justifyContent: 'center', py: 8 }}><CircularProgress /></Box>;

  return (
    <Box>
      <Typography variant="h5" sx={{ mb: 3, fontWeight: 600 }}>Agent 在线列表</Typography>
      <TableContainer component={Paper}>
        <Table>
          <TableHead>
            <TableRow><TableCell>状态</TableCell><TableCell>数量</TableCell></TableRow>
          </TableHead>
          <TableBody>
            {agents.map((a) => (
              <TableRow key={a.id}>
                <TableCell><Chip label={a.state} size="small" color={a.state === 'active' ? 'success' : 'default'} /></TableCell>
                <TableCell>{a.id}</TableCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>
      </TableContainer>
    </Box>
  );
}

export default AgentList;
