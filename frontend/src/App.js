import React, { useState, useEffect } from "react";
import axios from "axios";
import {
  Container,
  Typography,
  Button,
  Box,
  Table,
  TableBody,
  TableCell,
  TableContainer,
  TableHead,
  TableRow,
  Paper,
  Breadcrumbs,
  Link,
  LinearProgress,
  AppBar,
  Toolbar,
  Switch,
} from "@mui/material";
import { createTheme, ThemeProvider } from "@mui/material/styles";
import { CloudUpload, Folder, Delete, Download } from "@mui/icons-material";
import logo from "./assets/logo.png"; // ✅ Import your logo

function App() {
  const [bucketFiles, setBucketFiles] = useState([]);
  const [currentPrefix, setCurrentPrefix] = useState("");
  const [breadcrumbs, setBreadcrumbs] = useState(["root"]);
  const [uploadFiles, setUploadFiles] = useState([]);
  const [uploadProgress, setUploadProgress] = useState({});
  const [darkMode, setDarkMode] = useState(false);

  const theme = createTheme({
    palette: { mode: darkMode ? "dark" : "light" },
  });

  const fetchFiles = async (prefix = "") => {
    const response = await axios.get("/api/list_files", { params: { prefix } });
    setBucketFiles(response.data.files || []);
    setCurrentPrefix(prefix);
    setBreadcrumbs(prefix ? ["root", ...prefix.split("/").filter(Boolean)] : ["root"]);
  };

  const navigateTo = (prefix) => fetchFiles(prefix);
  const handleFileChange = (e) => setUploadFiles(Array.from(e.target.files));

  const uploadSelectedFiles = async () => {
    if (uploadFiles.length === 0) return;
    for (let file of uploadFiles) {
      const relativePath = file.webkitRelativePath || file.name;
      const key = currentPrefix ? currentPrefix + relativePath : relativePath;
      const response = await axios.post("/api/generate_presigned_url", {
        filename: key,
        filetype: file.type,
      });
      const { url } = response.data;
      await axios.put(url, file, {
        headers: { "Content-Type": file.type || "application/octet-stream" },
        onUploadProgress: (e) => {
          const percent = Math.round((e.loaded * 100) / e.total);
          setUploadProgress((prev) => ({ ...prev, [file.name]: percent }));
        },
      });
    }
    fetchFiles(currentPrefix);
    setUploadFiles([]);
    setUploadProgress({});
  };

  const downloadFile = async (key) => {
    const response = await axios.get("/api/download_file", { params: { key } });
    window.open(response.data.url, "_blank");
  };

  const deleteFile = async (key) => {
    if (!window.confirm(`Delete ${key}?`)) return;
    await axios.delete("/api/delete_file", { params: { key } });
    fetchFiles(currentPrefix);
  };

  const createFolder = async () => {
    const folderName = prompt("Enter new folder name:");
    if (!folderName) return;
    const prefix = currentPrefix ? currentPrefix + folderName + "/" : folderName + "/";
    await axios.post("/api/create_folder", null, { params: { prefix } });
    fetchFiles(currentPrefix);
  };

  useEffect(() => {
    fetchFiles();
  }, []);

  return (
    <ThemeProvider theme={theme}>
      <Box
        sx={{
          minHeight: "100vh",
          background: darkMode
            ? "linear-gradient(to right, #232526, #414345)"
            : "linear-gradient(to right, #f0f4f8, #d9e4ec)",
        }}
      >
        {/* App Bar with Logo */}
        <AppBar position="static" color="primary">
          <Toolbar>
            <Box
              component="img"
              src={logo}
              alt="TechnoIdentity Logo"
              sx={{ height: 40, mr: 2 }}
            />
            <Typography variant="h6" sx={{ flexGrow: 1 }}>
              S3 Explorer
            </Typography>
            <Typography>Dark Mode</Typography>
            <Switch checked={darkMode} onChange={() => setDarkMode(!darkMode)} />
          </Toolbar>
        </AppBar>

        <Container maxWidth="lg" sx={{ py: 4 }}>
          <Paper sx={{ p: 4, borderRadius: 3, boxShadow: 6 }}>
            {/* Breadcrumbs */}
            <Breadcrumbs sx={{ mb: 3 }}>
              {breadcrumbs.map((crumb, idx) => {
                const path =
                  breadcrumbs.slice(1, idx + 1).join("/") + (idx > 0 ? "/" : "");
                return (
                  <Link
                    key={idx}
                    underline="hover"
                    color="inherit"
                    onClick={() => navigateTo(path)}
                    sx={{ cursor: "pointer" }}
                  >
                    {crumb}
                  </Link>
                );
              })}
            </Breadcrumbs>

            {/* Upload Section */}
            <Box sx={{ mb: 3 }}>
              <Typography variant="h6">
                Upload to {currentPrefix || "root"}
              </Typography>
              <Box sx={{ display: "flex", gap: 2, mt: 2, flexWrap: "wrap" }}>
                <Button
                  variant="contained"
                  component="label"
                  startIcon={<CloudUpload />}
                >
                  Select Files
                  <input type="file" multiple hidden onChange={handleFileChange} />
                </Button>
                <Button
                  variant="outlined"
                  component="label"
                  startIcon={<Folder />}
                >
                  Select Folder
                  <input
                    type="file"
                    webkitdirectory="true"
                    directory="true"
                    multiple
                    hidden
                    onChange={handleFileChange}
                  />
                </Button>
                <Button
                  variant="contained"
                  color="success"
                  onClick={uploadSelectedFiles}
                  startIcon={<CloudUpload />}
                >
                  Upload
                </Button>
                <Button
                  variant="outlined"
                  color="info"
                  onClick={createFolder}
                  startIcon={<Folder />}
                >
                  New Folder
                </Button>
              </Box>
            </Box>

            {/* Selected Files */}
            {uploadFiles.length > 0 && (
              <Box sx={{ mb: 3 }}>
                <Typography variant="subtitle1">Selected Files:</Typography>
                {uploadFiles.map((f) => (
                  <Box key={f.name} sx={{ mb: 1 }}>
                    {f.webkitRelativePath || f.name}
                    {uploadProgress[f.name] !== undefined && (
                      <LinearProgress
                        variant="determinate"
                        value={uploadProgress[f.name]}
                      />
                    )}
                  </Box>
                ))}
              </Box>
            )}

            {/* Files Table */}
            <TableContainer component={Paper}>
              <Table>
                <TableHead>
                  <TableRow>
                    <TableCell>
                      <b>Name</b>
                    </TableCell>
                    <TableCell>
                      <b>Type</b>
                    </TableCell>
                    <TableCell>
                      <b>Size</b>
                    </TableCell>
                    <TableCell>
                      <b>Last Modified</b>
                    </TableCell>
                    <TableCell>
                      <b>Actions</b>
                    </TableCell>
                  </TableRow>
                </TableHead>
                <TableBody>
                  {bucketFiles.map((f) => (
                    <TableRow key={f.key} hover>
                      <TableCell>
                        {f.isFolder ? (
                          <Link
                            onClick={() => navigateTo(f.key)}
                            sx={{ cursor: "pointer" }}
                          >
                            📁 {f.name}
                          </Link>
                        ) : (
                          <>📄 {f.name}</>
                        )}
                      </TableCell>
                      <TableCell>{f.isFolder ? "Folder" : "File"}</TableCell>
                      <TableCell>
                        {f.isFolder
                          ? "-"
                          : (f.size / 1024).toFixed(2) + " KB"}
                      </TableCell>
                      <TableCell>
                        {f.isFolder ? "-" : f.last_modified}
                      </TableCell>
                      <TableCell>
                        {!f.isFolder && (
                          <>
                            <Button
                              size="small"
                              variant="outlined"
                              startIcon={<Download />}
                              sx={{ mr: 1 }}
                              onClick={() => downloadFile(f.key)}
                            >
                              Download
                            </Button>
                            <Button
                              size="small"
                              variant="outlined"
                              color="error"
                              startIcon={<Delete />}
                              onClick={() => deleteFile(f.key)}
                            >
                              Delete
                            </Button>
                          </>
                        )}
                      </TableCell>
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
            </TableContainer>
          </Paper>
        </Container>
      </Box>
    </ThemeProvider>
  );
}

export default App;