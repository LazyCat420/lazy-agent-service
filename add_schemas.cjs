const fs = require('fs');
const file = 'tool_schemas.json';
const data = JSON.parse(fs.readFileSync(file, 'utf8'));

const newTools = [
  {
    "name": "music_player_remove_node",
    "description": "Remove an artist or genre node from the user's interactive music graph.",
    "parameters": {
      "type": "object",
      "properties": {
        "node_id": { "type": "string", "description": "The exact name/id of the node to remove" }
      },
      "required": ["node_id"]
    },
    "tier": 0, "domain": "Music", "labels": ["tool"]
  },
  {
    "name": "music_player_add_edge",
    "description": "Add an edge (relationship) between two existing nodes in the music graph.",
    "parameters": {
      "type": "object",
      "properties": {
        "source": { "type": "string" },
        "target": { "type": "string" },
        "relationship": { "type": "string" }
      },
      "required": ["source", "target"]
    },
    "tier": 0, "domain": "Music", "labels": ["tool"]
  },
  {
    "name": "music_player_remove_edge",
    "description": "Remove a specific edge between two nodes.",
    "parameters": {
      "type": "object",
      "properties": {
        "source": { "type": "string" },
        "target": { "type": "string" }
      },
      "required": ["source", "target"]
    },
    "tier": 0, "domain": "Music", "labels": ["tool"]
  },
  {
    "name": "music_player_override_node_type",
    "description": "Explicitly override a node's type (e.g., force it to be an 'artist' or 'genre').",
    "parameters": {
      "type": "object",
      "properties": {
        "node_id": { "type": "string" },
        "group_type": { "type": "string", "enum": ["artist", "genre"] }
      },
      "required": ["node_id", "group_type"]
    },
    "tier": 0, "domain": "Music", "labels": ["tool"]
  },
  {
    "name": "music_player_expand_artist",
    "description": "Discover similar artists for a given artist using the AI pipeline. Returns new artists.",
    "parameters": {
      "type": "object",
      "properties": {
        "artist": { "type": "string" },
        "count": { "type": "integer" }
      },
      "required": ["artist"]
    },
    "tier": 0, "domain": "Music", "labels": ["tool"]
  },
  {
    "name": "music_player_expand_genre",
    "description": "Discover artists within a specific genre using the AI pipeline. Returns new artists.",
    "parameters": {
      "type": "object",
      "properties": {
        "genre": { "type": "string" },
        "count": { "type": "integer" }
      },
      "required": ["genre"]
    },
    "tier": 0, "domain": "Music", "labels": ["tool"]
  },
  {
    "name": "music_player_get_graph_state",
    "description": "Returns all currently discovered nodes and edges in the music graph.",
    "parameters": {
      "type": "object",
      "properties": {},
      "required": []
    },
    "tier": 0, "domain": "Music", "labels": ["tool"]
  },
  {
    "name": "music_player_search_artists",
    "description": "Returns all known artists in the local library.",
    "parameters": {
      "type": "object",
      "properties": {},
      "required": []
    },
    "tier": 0, "domain": "Music", "labels": ["tool"]
  },
  {
    "name": "music_player_get_artist_info",
    "description": "Retrieves biography, genre, and metadata for a specific artist.",
    "parameters": {
      "type": "object",
      "properties": {
        "name": { "type": "string" }
      },
      "required": ["name"]
    },
    "tier": 0, "domain": "Music", "labels": ["tool"]
  },
  {
    "name": "music_player_list_genres",
    "description": "Returns all genres and their associated artists in the library.",
    "parameters": {
      "type": "object",
      "properties": {},
      "required": []
    },
    "tier": 0, "domain": "Music", "labels": ["tool"]
  }
];

// Remove existing music_player tools to avoid duplicates
const filtered = data.filter(t => 
  t.name === "music_player_suggest_artists" || 
  t.name === "music_player_add_node" || 
  !t.name.startsWith("music_player_")
);

fs.writeFileSync(file, JSON.stringify([...filtered, ...newTools], null, 2));
console.log('Schemas updated successfully.');
