import { useEffect } from "react";
import "./App.css";
import { getRelayStatsClient } from "./relay";

const client = getRelayStatsClient();

function App() {
  useEffect(() => {
    const fetchEpochData = async () => {
      const epochData = await client.getEpochData();
      console.log(epochData);
    };
    fetchEpochData();
  }, []);

  return <div className="App"></div>;
}

export default App;
